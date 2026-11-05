import AppKit
import UserNotifications

/// Les types de notifications, chacun réglable (Réglages › Notifications).
enum NotifyKind: String, CaseIterable, Identifiable, Sendable {
    case waiting, sensitive, failed, question, accountWeek, missionDone, stopped, runaway, background

    var id: String { rawValue }

    var title: String {
        switch self {
        case .waiting: "Une conversation t'attend ou te pose une question"
        case .sensitive: "Une action sensible attend ton accord"
        case .failed: "Une action autorisée a échoué"
        case .question: "Vigie a répondu à une question à ta place"
        case .accountWeek: "Un compte passe 80 % puis 90 % de sa semaine"
        case .missionDone: "Une conversation ou un workflow a fini"
        case .stopped: "Une conversation s'arrête avant la fin"
        case .runaway: "Une conversation s'emballe"
        case .background: "Des processus oubliés prennent de la mémoire"
        }
    }

    var symbol: String {
        switch self {
        case .waiting: Icon.waiting
        case .sensitive: Icon.guardRule
        case .failed: "exclamationmark.triangle"
        case .question: Icon.question
        case .accountWeek: Icon.week
        case .missionDone: Icon.mission
        case .stopped: "pause.circle"
        case .runaway: Icon.runaway
        case .background: "memorychip"
        }
    }

    /// Ordre d'importance quand plusieurs notifications partent ensemble : les 3 premières font une bannière.
    var priority: Int {
        switch self {
        case .sensitive: 0
        case .waiting: 1
        case .stopped: 2
        case .failed: 3
        case .missionDone: 4
        case .runaway: 5
        case .question: 6
        case .background: 7
        case .accountWeek: 8
        }
    }

    var defaultsKey: String { "notify.\(rawValue)" }

    var isOn: Bool { UserDefaults.standard.object(forKey: defaultsKey) as? Bool ?? true }
}

/// Notifications Mac : une seule fois par élément (mémorisé d'un lancement à l'autre), clic = ouvre l'élément
/// dans Vigie. Une fin de demande n'a qu'une notification, remplacée sur place si la demande se termine à nouveau,
/// retirée quand la conversation reprend. Rien en démonstration ni en captures.
@MainActor
final class Notifier {
    static let shared = Notifier()

    private struct Candidate {
        var key: String
        var kind: NotifyKind
        var title: String
        var subtitle = ""
        var body: String
        var conversationId: String?
        var reviewId: String?
        /// Heure de l'élément : une version plus récente du même élément remplace sa notification, sans bannière.
        var version: Double = 0
        /// Toujours discrète : dans le centre de notifications, sans bannière.
        var quiet = false
    }

    private static let seenKey = "notify.seen"
    private static let seededKey = "notify.seeded"
    /// Un élément notifié est oublié au bout de 4 jours.
    private static let memory: TimeInterval = 4 * 86_400
    /// Une fin plus ancienne que ça ne fait plus de bannière (par exemple au lancement de l'app le matin).
    private static let staleEnd: TimeInterval = 15 * 60
    /// Un workflow fini attend ce délai : si la conversation reprend la main, il entre dans sa fin.
    private static let workflowGrace: TimeInterval = 2 * 60
    /// Au-delà, les notifications d'un même relevé vont dans le centre de notifications, sans bannière.
    private static let maxBanners = 3

    private var enabled = false
    private var seen: [String: Double] = [:]
    /// Version notifiée de chaque élément (en mémoire seulement).
    private var versions: [String: Double] = [:]
    /// Notifications affichées pour une attente encore en cours (retirées quand elle se termine).
    private var liveKeys: Set<String> = []
    /// Fins notifiées, par conversation : retirées quand elle reprend le travail.
    private var endKeys: [String: Set<String>] = [:]
    private let relay = NotificationRelay()

    /// Autorisation demandée par la dernière étape de l'accueil (ici seulement si l'accueil est déjà fait) ; le
    /// système ne redemande pas ensuite.
    func start(store: VigieStore) {
        guard !store.isDemo, !LaunchOptions.current.isSnapshot,
              Bundle.main.bundleIdentifier != nil, Bundle.main.bundlePath.hasSuffix(".app") else { return }
        enabled = true
        seen = (UserDefaults.standard.dictionary(forKey: Self.seenKey) as? [String: Double]) ?? [:]
        let center = UNUserNotificationCenter.current()
        center.delegate = relay
        if UserDefaults.standard.bool(forKey: OnboardingView.doneKey) {
            center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
    }

    /// Après chaque lecture de la vue d'ensemble : notifie ce qui est nouveau.
    func process(_ store: VigieStore) {
        guard enabled, store.loadedOnce else { return }
        let candidates = collect(store)
        let now = Date.now.timeIntervalSince1970
        let defaults = UserDefaults.standard

        // Premier lancement : ce qui existe déjà est considéré comme vu (pas de rafale).
        if !defaults.bool(forKey: Self.seededKey) {
            for candidate in candidates { seen[candidate.key] = now; versions[candidate.key] = candidate.version }
            defaults.set(true, forKey: Self.seededKey)
            save()
            return
        }

        // La conversation a repris le travail : sa fin annoncée n'est plus vraie.
        for conversation in store.conversations where conversation.state == .working {
            if let keys = endKeys.removeValue(forKey: conversation.id), !keys.isEmpty {
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: Array(keys))
            }
        }

        let fresh = candidates.filter { seen[$0.key] == nil }
        // Même élément, version plus récente (la même demande se termine à nouveau) : remplacée sur place.
        let updated = candidates.filter { candidate in
            guard seen[candidate.key] != nil, let known = versions[candidate.key] else { return false }
            return candidate.version > known
        }
        for candidate in fresh + updated {
            seen[candidate.key] = seen[candidate.key] ?? now
            versions[candidate.key] = candidate.version
        }

        let shown = fresh.filter(\.kind.isOn).sorted { $0.kind.priority < $1.kind.priority }
        for (index, candidate) in shown.enumerated() {
            post(candidate, banner: index < Self.maxBanners && !candidate.quiet && !isInFront(candidate, store))
        }
        for candidate in updated where candidate.kind.isOn { post(candidate, banner: false) }

        // Attentes terminées (autorisée, répondue, délai passé) : leur notification disparaît.
        let live = Set(candidates.filter { $0.kind == .waiting || $0.kind == .sensitive }.map(\.key))
        let ended = liveKeys.subtracting(live)
        if !ended.isEmpty {
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: Array(ended))
        }
        liveKeys = live

        let before = seen.count
        seen = seen.filter { now - $0.value < Self.memory }
        versions = versions.filter { seen[$0.key] != nil }
        if !fresh.isEmpty || seen.count != before { save() }
    }

    /// La page de cette conversation est devant toi : la notification va dans le centre de notifications, sans bannière.
    private func isInFront(_ candidate: Candidate, _ store: VigieStore) -> Bool {
        guard let id = candidate.conversationId, NSApplication.shared.isActive,
              case .conversation(let shown) = store.route else { return false }
        return shown == id
    }

    // MARK: Ce qui mérite une notification

    private func collect(_ store: VigieStore) -> [Candidate] {
        var list: [Candidate] = []
        func name(_ id: String?, _ fallback: String?) -> String {
            id.flatMap { store.conversation($0)?.shortTitle } ?? fallback ?? "Une conversation"
        }

        for item in store.toReview {
            let conversation = name(item.conversationId, item.conversationTitle)
            switch item.reviewKind {
            case .waiting:
                list.append(waiting(item, conversation: conversation, store: store))
            case .blocked where item.needsDecision:
                let what = item.rule ?? item.title ?? "Action sensible"
                let command = item.command.map { String($0.prefix(160)) } ?? ""
                list.append(Candidate(key: "r:" + item.id, kind: .sensitive, title: "À autoriser · \(conversation)",
                                      subtitle: what, body: command.isEmpty ? what : command,
                                      conversationId: item.conversationId, reviewId: item.id))
            case .blocked where item.failed:
                list.append(Candidate(key: "r:" + item.id, kind: .failed, title: "Action autorisée en échec · \(conversation)",
                                      body: item.detail ?? item.rule ?? "L'action autorisée a échoué",
                                      conversationId: item.conversationId, reviewId: item.id))
            case .question:
                let chosen = item.question?.items.first?.chosenLabels.joined(separator: ", ")
                var body = "« \(item.title ?? "Question") »"
                if let chosen, !chosen.isEmpty { body += " → \(chosen)" }
                list.append(Candidate(key: "r:" + item.id, kind: .question,
                                      title: "Réponse choisie pour toi · \(conversation)",
                                      body: body, conversationId: nil, reviewId: item.id))
            case .limit:
                // Arrêtée par une limite : elle n'a pas fini. Seulement si c'est récent.
                guard recent(item.ts) else { continue }
                list.append(Candidate(key: "r:" + item.id, kind: .stopped, title: "\(conversation) s'est arrêtée, pas finie",
                                      subtitle: item.title ?? "Limite atteinte", body: item.detail ?? "Limite atteinte",
                                      conversationId: item.conversationId, reviewId: nil))
            case .blocked, .other:
                continue
            }
        }

        for account in store.accounts {
            guard let week = account.usage?.week, let pct = week.pct else { continue }
            let period = week.resetsAt.map { String(Int($0.timeIntervalSince1970)) } ?? "?"
            let crossed = [90, 80].filter { pct >= Double($0) }
            guard let top = crossed.first else { continue }
            // Le seuil le plus haut passé ; les seuils inférieurs sont marqués vus en même temps.
            for threshold in crossed.dropFirst() {
                let key = "a:\(account.id):\(threshold):\(period)"
                if seen[key] == nil { seen[key] = Date.now.timeIntervalSince1970 }
            }
            var body = "\(Fmt.pct(pct)) de la semaine utilisés"
            if let reset = week.resetsAt { body += " · remise à zéro \(Fmt.reset(reset, now: store.now))" }
            list.append(Candidate(key: "a:\(account.id):\(top):\(period)", kind: .accountWeek,
                                  title: "\(account.displayName) passe \(top) % de sa semaine", body: body,
                                  conversationId: nil, reviewId: nil))
        }

        let reports = store.reports.map(\.value)
        for report in reports {
            switch report.reportKind {
            case .missionDone:
                if let candidate = missionEnd(report, store: store, name: name) { list.append(candidate) }
            case .workflowDone:
                if let candidate = workflowEnd(report, reports: reports, store: store, name: name) { list.append(candidate) }
            case .artifact, .other:
                continue
            }
        }

        list.append(contentsOf: background(store))

        for conversation in store.conversations {
            guard let alert = conversation.alert, alert.isRunaway else { continue }
            // Une seule notification par conversation et par tranche de 3 h : « since » glisse avec la fenêtre
            // de 20 min et le compteur change, ce qui relançait une notification à chaque relecture.
            let slot = Int(Date().timeIntervalSince1970 / 10_800)
            list.append(Candidate(key: "e:\(conversation.id):\(slot)", kind: .runaway,
                                  title: "\(conversation.shortTitle) s'emballe",
                                  body: alert.reason ?? "Consommation anormale",
                                  conversationId: conversation.id, reviewId: nil))
        }
        return list
    }

    /// Ce que les conversations ont laissé tourner : chaque arrêt automatique (discret), et une alerte par jour au plus
    /// quand les oubliés pèsent (2 Go, ou 10 processus).
    private func background(_ store: VigieStore) -> [Candidate] {
        guard let summary = store.backgroundSummary else { return [] }
        var list: [Candidate] = []
        for stop in summary.autoStopped where recent(stop.ts) {
            var parts: [String] = []
            if let project = stop.project { parts.append(project) }
            if let processes = stop.processes { parts.append(Fmt.count(processes, "processus", "processus")) }
            parts.append("\(Fmt.memory(mb: stop.memoryMb)) libérés")
            list.append(Candidate(key: "bg:auto:\(stop.id)", kind: .background,
                                  title: "\(stop.label ?? "Chrome sans fenêtre") oublié, arrêté par Vigie",
                                  body: parts.joined(separator: " · "), conversationId: nil, reviewId: nil, quiet: true))
        }
        let count = summary.forgotten ?? 0, mb = summary.forgottenMb ?? 0, processes = summary.forgottenProcesses ?? 0
        if count > 0 && (mb >= 2048 || processes >= 10) {
            let day = Date.now.formatted(.iso8601.year().month().day())
            list.append(Candidate(key: "bg:day:\(day)", kind: .background,
                                  title: "En fond : \(Fmt.count(count, "oublié")) · \(Fmt.memory(mb: mb))",
                                  subtitle: "Leurs conversations sont fermées",
                                  body: summary.forgottenLabels.joined(separator: ", "), conversationId: nil, reviewId: nil))
        }
        return list
    }

    /// Une conversation t'attend : sa question si Vigie l'a vue, sinon ce qu'elle dit attendre.
    private func waiting(_ item: ReviewItem, conversation: String, store: VigieStore) -> Candidate {
        if item.id.hasPrefix("w:") {
            let isPlan = item.title == "Plan à valider"
            return Candidate(key: "r:" + item.id, kind: .waiting,
                             title: isPlan ? "\(conversation) te propose un plan" : "\(conversation) te pose une question",
                             subtitle: Self.deadline(item.detail), body: item.title ?? "Elle attend ta réponse",
                             conversationId: item.conversationId, reviewId: nil)
        }
        let summary = item.conversationId.flatMap { store.conversation($0) }
        let stamp = item.ts.map { String(Int($0.timeIntervalSince1970)) } ?? ""
        return Candidate(key: "r:\(item.id):\(stamp)", kind: .waiting, title: "\(conversation) t'attend",
                         body: summary?.waitingFor ?? item.detail ?? "Elle attend ta réponse",
                         conversationId: item.conversationId, reviewId: nil)
    }

    /// « sinon Vigie choisit l'option recommandée dans 4 min » tiré de la consigne du moteur.
    private static func deadline(_ detail: String?) -> String {
        guard let detail, let range = detail.range(of: "Vigie choisit") else { return "" }
        let rest = detail[range.lowerBound...].trimmingCharacters(in: CharacterSet(charactersIn: ". "))
        return String(rest)
    }

    /// Une demande vraiment finie : au repos, plus rien qui tourne, pas trop ancienne.
    private func missionEnd(_ report: Report, store: VigieStore, name: (String?, String?) -> String) -> Candidate? {
        guard recent(report.ts) else { return nil }
        let summary = report.conversationId.flatMap { store.conversation($0) }
        if let summary, summary.state == .working || (summary.agentsRunning ?? 0) > 0 || (summary.workflowsRunning ?? 0) > 0 {
            return nil // pas encore fini : la notification partira à un relevé suivant
        }
        let conversation = name(report.conversationId, report.conversationTitle)
        let version = report.ts?.timeIntervalSince1970 ?? 0
        let key = "m:" + report.stableKey
        if let question = report.question, !question.isEmpty {
            return remember(Candidate(key: key, kind: .waiting, title: "\(conversation) te pose une question",
                                      subtitle: report.prompt ?? "", body: question,
                                      conversationId: report.conversationId, version: version))
        }
        let duration = Fmt.duration(ms: report.durationMs)
        var lines = [report.title ?? "Terminée"]
        if let facts = report.detail, !facts.isEmpty { lines.append(facts) }
        if let toYou = report.toYou, !toYou.isEmpty { lines.append("À toi : " + toYou) }
        return remember(Candidate(key: key, kind: .missionDone,
                                  title: duration.isEmpty ? "\(conversation) a fini" : "\(conversation) a fini · \(duration)",
                                  subtitle: summary?.title ?? report.prompt ?? "", body: lines.joined(separator: "\n"),
                                  conversationId: report.conversationId, version: version))
    }

    /// Un workflow fini : en échec ou arrêté, toujours ; réussi, seulement si la conversation n'a pas repris la main
    /// (sinon il entre dans la fin de la conversation).
    private func workflowEnd(_ report: Report, reports: [Report], store: VigieStore,
                             name: (String?, String?) -> String) -> Candidate? {
        guard recent(report.ts), let end = report.ts else { return nil }
        let summary = report.conversationId.flatMap { store.conversation($0) }
        let failed = report.status == "failed", stopped = report.status == "killed"
        if !failed && !stopped {
            if Date.now.timeIntervalSince(end) < Self.workflowGrace { return nil }
            if summary?.state == .working { return nil }
            let endedAfter = reports.contains { other in
                other.reportKind == .missionDone && other.conversationId == report.conversationId && (other.ts ?? .distantPast) >= end
            }
            if endedAfter { return nil }
        }
        let conversation = name(report.conversationId, report.conversationTitle)
        let outcome = failed ? "en échec" : stopped ? "arrêté" : "fini"
        var facts: [String] = []
        if let agents = report.agents, agents > 0 {
            facts.append(Fmt.count(agents, "agent") + ((report.agentsFailed ?? 0) > 0 ? ", \(report.agentsFailed ?? 0) en échec" : ""))
        }
        let duration = Fmt.duration(ms: report.durationMs)
        if !duration.isEmpty { facts.append(duration) }
        var lines: [String] = []
        if let detail = report.detail, !detail.isEmpty { lines.append(detail) }
        if !facts.isEmpty { lines.append(facts.joined(separator: " · ")) }
        return remember(Candidate(key: "m:" + report.stableKey, kind: failed || stopped ? .stopped : .missionDone,
                                  title: "\(conversation) · workflow \(outcome)", subtitle: report.title ?? "",
                                  body: lines.isEmpty ? "Workflow \(outcome)" : lines.joined(separator: "\n"),
                                  conversationId: report.conversationId, version: end.timeIntervalSince1970))
    }

    /// Une fin notifiée est retirée si sa conversation reprend le travail.
    private func remember(_ candidate: Candidate) -> Candidate {
        if let id = candidate.conversationId { endKeys[id, default: []].insert(candidate.key) }
        return candidate
    }

    private func recent(_ date: Date?) -> Bool {
        date.map { Date.now.timeIntervalSince($0) < Self.staleEnd } ?? false
    }

    // MARK: Envoi et clic

    private func post(_ candidate: Candidate, banner: Bool) {
        let content = UNMutableNotificationContent()
        content.title = candidate.title
        if !candidate.subtitle.isEmpty { content.subtitle = candidate.subtitle }
        content.body = candidate.body
        // Rangées par conversation dans le centre de notifications.
        content.threadIdentifier = candidate.conversationId ?? candidate.kind.rawValue
        content.interruptionLevel = banner ? .active : .passive
        if banner && (candidate.kind == .sensitive || candidate.kind == .runaway) { content.sound = .default }
        var info: [String: String] = ["kind": candidate.kind.rawValue]
        if let id = candidate.conversationId { info["conversationId"] = id }
        if let id = candidate.reviewId { info["reviewId"] = id }
        content.userInfo = info
        let request = UNNotificationRequest(identifier: candidate.key, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { _ in }
    }

    /// Clic sur une notification : la fenêtre de Vigie s'ouvre sur l'élément.
    func open(kind: String?, conversationId: String?, reviewId: String?) {
        let store = VigieStore.shared
        if let reviewId, let item = store.toReview.first(where: { $0.id == reviewId }) {
            store.route = .overview
            switch item.reviewKind {
            case .question: store.changeRequest = item
            case .blocked: store.blockedRequest = item
            case .waiting, .limit, .other: break
            }
        } else if kind == NotifyKind.accountWeek.rawValue {
            store.showAccounts(nil)
        } else if kind == NotifyKind.background.rawValue {
            store.route = .background
        } else if let conversationId, store.conversation(conversationId) != nil {
            store.route = .conversation(conversationId)
        } else {
            store.route = .overview
        }
        store.openMainWindow?()
        NSApplication.shared.activate()
    }

    private func save() {
        UserDefaults.standard.set(seen, forKey: Self.seenKey)
    }
}

/// Délégué du centre de notifications : bannière même quand Vigie est devant (sauf notification discrète),
/// clic relayé à Vigie.
final class NotificationRelay: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let quiet = notification.request.content.interruptionLevel == .passive
        completionHandler(quiet ? [.list] : [.banner, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let kind = info["kind"] as? String
        let conversationId = info["conversationId"] as? String
        let reviewId = info["reviewId"] as? String
        Task { @MainActor in
            Notifier.shared.open(kind: kind, conversationId: conversationId, reviewId: reviewId)
        }
        completionHandler()
    }
}
