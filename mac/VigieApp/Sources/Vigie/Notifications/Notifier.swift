import AppKit
import UserNotifications

/// Les types de notifications, chacun réglable (Réglages › Notifications).
enum NotifyKind: String, CaseIterable, Identifiable, Sendable {
    case waiting, sensitive, failed, question, accountWeek, missionDone, runaway

    var id: String { rawValue }

    var title: String {
        switch self {
        case .waiting: "Une conversation t'attend"
        case .sensitive: "Une action sensible attend ton accord"
        case .failed: "Une action autorisée a échoué"
        case .question: "Vigie a répondu à une question à ta place"
        case .accountWeek: "Un compte passe 80 % puis 90 % de sa semaine"
        case .missionDone: "Une conversation finit un long travail"
        case .runaway: "Une conversation s'emballe"
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
        case .runaway: Icon.runaway
        }
    }

    var defaultsKey: String { "notify.\(rawValue)" }

    var isOn: Bool { UserDefaults.standard.object(forKey: defaultsKey) as? Bool ?? true }
}

/// Notifications Mac : une seule fois par élément (mémorisé d'un lancement à l'autre),
/// clic = ouvre l'élément dans Vigie. Rien en démonstration ni en captures.
@MainActor
final class Notifier {
    static let shared = Notifier()

    private struct Candidate {
        var key: String
        var kind: NotifyKind
        var title: String
        var body: String
        var conversationId: String?
        var reviewId: String?
    }

    private static let seenKey = "notify.seen"
    private static let seededKey = "notify.seeded"
    /// Un élément notifié est oublié au bout de 4 jours.
    private static let memory: TimeInterval = 4 * 86_400

    private var enabled = false
    private var seen: [String: Double] = [:]
    /// Notifications affichées pour une attente encore en cours (retirées quand elle se termine).
    private var liveKeys: Set<String> = []
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
            for candidate in candidates { seen[candidate.key] = now }
            defaults.set(true, forKey: Self.seededKey)
            save()
            return
        }

        let fresh = candidates.filter { seen[$0.key] == nil }
        for candidate in fresh { seen[candidate.key] = now }
        let shown = fresh.filter(\.kind.isOn)
        if shown.count > 3 {
            post(Candidate(key: "groupe:\(Int(now))", kind: shown[0].kind,
                           title: "\(shown.count) éléments à regarder",
                           body: shown.prefix(3).map(\.title).joined(separator: " · "),
                           conversationId: nil, reviewId: nil))
        } else {
            shown.forEach(post)
        }

        // Attentes terminées (autorisée, répondue, délai passé) : leur notification disparaît.
        let live = Set(candidates.filter { $0.kind == .waiting || $0.kind == .sensitive }.map(\.key))
        let ended = liveKeys.subtracting(live)
        if !ended.isEmpty {
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: Array(ended))
        }
        liveKeys = live

        let before = seen.count
        seen = seen.filter { now - $0.value < Self.memory }
        if !fresh.isEmpty || seen.count != before { save() }
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
                list.append(Candidate(key: "r:" + item.id, kind: .waiting, title: "\(conversation) t'attend",
                                      body: item.detail ?? item.title ?? "Elle attend ta réponse",
                                      conversationId: item.conversationId, reviewId: nil))
            case .blocked where item.needsDecision:
                let what = item.rule ?? item.title ?? "Action sensible"
                let command = item.command.map { " : " + String($0.prefix(120)) } ?? ""
                list.append(Candidate(key: "r:" + item.id, kind: .sensitive, title: "À autoriser · \(conversation)",
                                      body: what + command, conversationId: item.conversationId, reviewId: item.id))
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
            case .blocked, .limit, .other:
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

        for row in store.reports {
            let report = row.value
            guard report.reportKind == .missionDone || report.reportKind == .workflowDone else { continue }
            let conversation = name(report.conversationId, report.conversationTitle)
            list.append(Candidate(key: "m:" + report.stableKey, kind: .missionDone,
                                  title: "Travail terminé · \(conversation)",
                                  body: report.title ?? report.detail ?? "Terminée",
                                  conversationId: report.conversationId, reviewId: nil))
        }

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

    // MARK: Envoi et clic

    private func post(_ candidate: Candidate) {
        let content = UNMutableNotificationContent()
        content.title = candidate.title
        content.body = candidate.body
        content.threadIdentifier = candidate.kind.rawValue
        if candidate.kind == .sensitive || candidate.kind == .runaway { content.sound = .default }
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

/// Délégué du centre de notifications : bannière même quand Vigie est devant, clic relayé à Vigie.
final class NotificationRelay: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list])
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
