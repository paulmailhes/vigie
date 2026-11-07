import AppKit
import UserNotifications

/// Les types de notifications, chacun réglable (Réglages › Notifications).
enum NotifyKind: String, CaseIterable, Identifiable, Sendable {
    case waiting, sensitive, failed, question, accountSession, accountWeek, missionDone, stopped, runaway, background

    var id: String { rawValue }

    var title: String {
        switch self {
        case .waiting: "Une conversation t'attend ou te pose une question"
        case .sensitive: "Une action sensible attend ton accord"
        case .failed: "Une action autorisée a échoué"
        case .question: "Vigie a répondu à une question à ta place"
        case .accountSession: "Un compte passe 90 % de sa session pendant qu'une conversation tourne"
        case .accountWeek: "Un compte passe 80 % puis 90 % de sa semaine, ou sera plein avant la remise à zéro"
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
        case .accountSession: Icon.limit
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
        case .accountSession: 3
        case .failed: 4
        case .missionDone: 5
        case .runaway: 6
        case .question: 7
        case .background: 8
        case .accountWeek: 9
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
        /// Le compte concerné (session presque pleine) : le clic ouvre sa page si aucune conversation n'est à ouvrir.
        var accountId: String?
        /// La conversation que le clic ouvre, sans ranger la notification avec elle (`conversationId` le fait).
        var opens: String?
    }

    private static let seenKey = "notify.seen"
    private static let seededKey = "notify.seeded"
    /// Format des clés : 2 depuis la 0.3.28 (alerte de la semaine à l'heure près, avis du moteur sans heure).
    private static let keysVersionKey = "notify.keysVersion"
    private static let keysVersion = 2
    /// Un élément notifié est oublié au bout de 4 jours ; une alerte de la semaine d'un compte au bout de 8 (sinon
    /// elle repartait en fin de semaine, sa clé oubliée).
    private static func memory(for key: String) -> TimeInterval {
        key.hasPrefix("a:") || key.hasPrefix("f:") ? 8 * 86_400 : 4 * 86_400
    }
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
            defaults.set(Self.keysVersion, forKey: Self.keysVersionKey)
            save()
            return
        }

        // Mise à jour depuis la 0.3.27 : les alertes de la semaine et les avis du moteur ont changé de clé. Ceux déjà là
        // sont considérés comme vus, une fois (sinon « Travail 1 passe 90 % de sa semaine » ou « Perso : à
        // reconnecter » repartiraient à la mise à jour).
        if defaults.integer(forKey: Self.keysVersionKey) < Self.keysVersion {
            let notices = Set(store.toReview.filter { $0.reviewKind == .other }.map { "r:" + $0.id })
            for candidate in candidates where candidate.key.hasPrefix("a:") || notices.contains(candidate.key) {
                seen[candidate.key] = seen[candidate.key] ?? now
                versions[candidate.key] = candidate.version
            }
            defaults.set(Self.keysVersion, forKey: Self.keysVersionKey)
            save()
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
        seen = seen.filter { now - $0.value < Self.memory(for: $0.key) }
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
                // ce que c'est et ce qui se passe sans réponse ; jamais la commande brute (elle est dans la fiche)
                list.append(Candidate(key: "r:" + item.id, kind: .sensitive, title: "À autoriser · \(conversation)",
                                      subtitle: item.title ?? item.rule ?? "Action sensible", body: Self.sensitiveBody(item),
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
            case .other:
                // un avis du moteur (compte à reconnecter, compte changé, module Codex) : son propre titre, jamais
                // « … t'attend » (rien à décider dans une conversation), et sa conversation en sous-titre (après « Tout
                // passer sur… », quatre « Compte changé » disent chacun laquelle relancer)
                list.append(Candidate(key: "r:" + item.id, kind: .waiting, title: item.title ?? "Vigie",
                                      subtitle: item.conversationId != nil ? conversation : "",
                                      body: item.detail ?? "", conversationId: item.conversationId, reviewId: nil,
                                      accountId: item.accountId))
            case .blocked:
                continue
            }
        }

        for account in store.accounts {
            guard let week = account.usage?.week, let pct = week.pct else { continue }
            let crossed = [90, 80].filter { pct >= Double($0) }
            guard let top = crossed.first else { continue }
            // Le seuil le plus haut passé ; les seuils inférieurs sont marqués vus en même temps.
            for threshold in crossed.dropFirst() {
                let key = Self.weekKey(accountId: account.id, threshold: threshold, reset: week.resetsAt)
                if seen[key] == nil { seen[key] = Date.now.timeIntervalSince1970 }
            }
            var body = "\(Fmt.pct(pct)) de la semaine utilisés"
            if let reset = week.resetsAt { body += " · remise à zéro \(Fmt.reset(reset, now: store.now))" }
            list.append(Candidate(key: Self.weekKey(accountId: account.id, threshold: top, reset: week.resetsAt), kind: .accountWeek,
                                  title: "\(account.displayName) passe \(top) % de sa semaine", body: body,
                                  conversationId: nil, reviewId: nil, accountId: account.id))
        }

        list.append(contentsOf: weekForecasts(store))
        list.append(contentsOf: sessionAlerts(store))

        let reports = store.reports.map(\.value)
        for report in reports {
            switch report.reportKind {
            case .missionDone:
                if let candidate = missionEnd(report, store: store, name: name) { list.append(candidate) }
            case .workflowDone:
                if let candidate = workflowEnd(report, reports: reports, store: store, name: name) { list.append(candidate) }
            case .agentDone:
                if let candidate = agentEnd(report, store: store, name: name) { list.append(candidate) }
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

    /// Une conversation t'attend : sa question si Vigie l'a vue, sinon ce qu'elle dit attendre. Le clic ouvre la
    /// conversation, et la fiche pour répondre d'ici quand la question s'y prête.
    private func waiting(_ item: ReviewItem, conversation: String, store: VigieStore) -> Candidate {
        if item.id.hasPrefix("w:") {
            return Candidate(key: "r:" + item.id, kind: .waiting,
                             title: Self.isPlan(item.title) ? "\(conversation) te propose un plan" : "\(conversation) te pose une question",
                             subtitle: Self.deadline(item.detail), body: item.title ?? "Elle attend ta réponse",
                             conversationId: item.conversationId, reviewId: item.id)
        }
        let summary = item.conversationId.flatMap { store.conversation($0) }
        let stamp = item.ts.map { String(Int($0.timeIntervalSince1970)) } ?? ""
        return Candidate(key: "r:\(item.id):\(stamp)", kind: .waiting, title: "\(conversation) t'attend",
                         body: summary?.waitingFor ?? item.detail ?? "Elle attend ta réponse",
                         conversationId: item.conversationId, reviewId: item.id)
    }

    /// Un plan à approuver : le titre que le moteur donne à ExitPlanMode (l'ancien « Plan à valider » compris).
    static func isPlan(_ title: String?) -> Bool {
        title == "Plan à approuver" || title == "Plan à valider"
    }

    /// Le corps d'une notification d'action sensible. Le texte est figé une fois posté : une heure fixe, pas un délai.
    static func sensitiveBody(_ item: ReviewItem) -> String {
        if let expires = item.expiresAt {
            return "Refusée à \(Fmt.time(expires)) sans réponse. Clique pour décider."
        }
        if item.isAwaitingApproval {
            return "Elle a continué sans. Autorise-la pour qu'elle la relance."
        }
        return "Clique pour décider."
    }

    /// La semaine d'un compte serait pleine avant sa remise à zéro, au rythme des dernières 24 h (`WeekForecast`) :
    /// « Travail 1 sera plein avant la remise à zéro (vers jeu. 14 h) ». Une seule fois par compte et par semaine, même
    /// si la prévision disparaît puis revient (la remise à zéro, à l'heure près, fait la clé).
    private func weekForecasts(_ store: VigieStore) -> [Candidate] {
        store.accounts.compactMap { account in
            guard account.isConnected, let week = account.usage?.week,
                  let title = WeekForecast.notificationTitle(account: account.displayName, week: week, now: store.now)
            else { return nil }
            return Candidate(key: Self.forecastKey(accountId: account.id, reset: week.resetsAt, now: store.now),
                             kind: .accountWeek, title: title, body: Self.forecastBody(week, now: store.now),
                             conversationId: nil, reviewId: nil, accountId: account.id)
        }
    }

    /// Clé de la prévision : le compte et la remise à zéro arrondie à l'heure (le relevé dit 18:59 ou 19:00) ; sans
    /// remise à zéro connue, la tranche de 7 jours.
    static func forecastKey(accountId: String, reset: Date?, now: Date) -> String {
        "f:\(accountId):\(period(reset, step: 3600) ?? "w\(Int(now.timeIntervalSince1970 / 604_800))")"
    }

    /// Clé des alertes 80 % / 90 % de la semaine : une fois par seuil et par semaine, la remise à zéro arrondie à
    /// l'heure la plus proche (comme la prévision : 19:59:59 et 20:00:00 font la même semaine).
    static func weekKey(accountId: String, threshold: Int, reset: Date?) -> String {
        "a:\(accountId):\(threshold):\(period(reset, step: 3600) ?? "?")"
    }

    /// Clé de l'alerte 90 % de la session : la remise à zéro aux 10 min les plus proches (le relevé dit 03:59:59 ou
    /// 04:00:00 : arrondi vers le bas, deux tranches et deux bannières) ; sans elle, la tranche de 5 h.
    static func sessionKey(accountId: String, reset: Date?, now: Date) -> String {
        "s:\(accountId):\(period(reset, step: 600) ?? "t\(Int(now.timeIntervalSince1970 / 18_000))")"
    }

    /// Une remise à zéro arrondie au pas le plus proche, pour une clé qui ne bouge pas avec le relevé.
    private static func period(_ reset: Date?, step: TimeInterval) -> String? {
        reset.map { String(Int(($0.timeIntervalSince1970 / step).rounded())) }
    }

    /// « 62 % de la semaine utilisés · remise à zéro lun. 26 oct. à 20:00 ».
    static func forecastBody(_ week: UsageWindow, now: Date) -> String {
        var body = "\(Fmt.pct(week.pct)) de la semaine utilisés"
        if let reset = week.resetsAt { body += " · remise à zéro \(Fmt.reset(reset, now: now))" }
        return body
    }

    /// Un compte passe 90 % de sa session pendant qu'une conversation ouverte tourne dessus : elle va bientôt
    /// s'arrêter. Une seule fois par compte et par session (la remise à zéro fait la clé).
    private func sessionAlerts(_ store: VigieStore) -> [Candidate] {
        store.accounts.compactMap { account in
            guard let session = account.usage?.session, let pct = session.pct,
                  pct >= AccountGauge.sessionAlert, pct < 100 else { return nil }
            let running = store.working(on: account.id)
            guard !running.isEmpty else { return nil }
            return Candidate(key: Self.sessionKey(accountId: account.id, reset: session.resetsAt, now: Date.now), kind: .accountSession,
                             title: "\(account.displayName) à \(Fmt.pct(pct)) de sa session",
                             body: Self.sessionBody(running.map(\.shortTitle), reset: session.resetsAt),
                             conversationId: nil, reviewId: nil, accountId: account.id,
                             opens: running.count == 1 ? running.first?.id : nil)
        }
    }

    /// « Atelier va bientôt s'arrêter (remise à zéro à 03:40) », « Atelier et Boutique vont bientôt s'arrêter ».
    static func sessionBody(_ names: [String], reset: Date?) -> String {
        let who: String
        switch names.count {
        case 0: who = "La conversation"
        case 1: who = names[0]
        default: who = names.dropLast().joined(separator: ", ") + " et " + (names.last ?? "")
        }
        let verb = names.count > 1 ? "vont" : "va"
        let when = reset.map { " (remise à zéro à \(Fmt.time($0)))" } ?? ""
        return "\(who) \(verb) bientôt s'arrêter\(when)"
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

    /// Un agent lancé seul, fini après plus de 10 min : dans le centre de notifications, sans bannière ; une bannière
    /// s'il échoue, ou si personne ne lira son résultat (conversation fermée, ou au repos 2 min après sa fin).
    private func agentEnd(_ report: Report, store: VigieStore, name: (String?, String?) -> String) -> Candidate? {
        guard recent(report.ts), let end = report.ts else { return nil }
        let summary = report.conversationId.flatMap { store.conversation($0) }
        let failed = report.status == "failed" || report.status == "killed"
        let unread = summary == nil || summary?.state == .closed
            || (summary?.state == .idle && Date.now.timeIntervalSince(end) > 120)
        if !failed && !unread && Date.now.timeIntervalSince(end) < 120 && summary?.state != .working { return nil } // elle va le lire
        let conversation = name(report.conversationId, report.conversationTitle)
        let duration = Fmt.duration(ms: report.durationMs)
        return Candidate(key: "m:" + report.stableKey, kind: failed ? .stopped : .missionDone,
                         title: "\(conversation) · agent \(failed ? "en échec" : "fini") : \(report.title ?? "agent")",
                         subtitle: duration, body: report.detail ?? (failed ? "Il s'est arrêté sans résultat" : "Fini"),
                         conversationId: report.conversationId, reviewId: nil,
                         version: end.timeIntervalSince1970, quiet: !failed && !unread)
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
        if let id = candidate.opens ?? candidate.conversationId { info["conversationId"] = id }
        if let id = candidate.reviewId { info["reviewId"] = id }
        if let id = candidate.accountId { info["accountId"] = id }
        content.userInfo = info
        let request = UNNotificationRequest(identifier: candidate.key, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { _ in }
    }

    /// Clic sur une notification : la fenêtre de Vigie s'ouvre sur l'élément. Ce qui t'attend s'ouvre dans sa
    /// conversation, puis sa fiche (action sensible, question) ; « t'attend » : la conversation seule.
    func open(kind: String?, conversationId: String?, reviewId: String?, accountId: String? = nil) {
        let store = VigieStore.shared
        if let reviewId, let item = store.toReview.first(where: { $0.id == reviewId }) {
            store.open(review: item)
        } else if kind == NotifyKind.accountSession.rawValue {
            if let conversationId, store.conversation(conversationId) != nil {
                store.route = .conversation(conversationId)
            } else {
                store.showAccounts(accountId)
            }
        } else if kind == NotifyKind.accountWeek.rawValue {
            store.showAccounts(accountId)
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
        let accountId = info["accountId"] as? String
        Task { @MainActor in
            Notifier.shared.open(kind: kind, conversationId: conversationId, reviewId: reviewId, accountId: accountId)
        }
        completionHandler()
    }
}
