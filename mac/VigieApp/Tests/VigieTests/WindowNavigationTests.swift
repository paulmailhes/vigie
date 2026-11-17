import Foundation
import Testing
@testable import Vigie

/// La fenêtre : le badge rouge, la limite d'un compte, les notifications, Retour / Suivant et « Suivante qui
/// t'attend ».
@MainActor
struct WindowNavigationTests {
    /// Les données d'exemple du dépôt (mac/VigieApp/Preview) : Atelier, Boutique, Portail.
    private static var previewFolder: URL {
        URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Preview", directoryHint: .isDirectory)
    }

    private func demoStore() async -> VigieStore {
        let store = VigieStore(client: VigieClient(source: .fixtures(Self.previewFolder)))
        await store.refreshOverview()
        return store
    }

    private func usage(_ json: String) throws -> AccountUsage {
        try JSONDecoder().decode(AccountUsage.self, from: Data(json.utf8))
    }

    @Test func accountGaugeShowsTheLimitThatBlocks() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let reset = now.addingTimeInterval(2 * 3600)
        let iso = reset.formatted(.iso8601)

        // session pleine : la semaine à côté du nom, « Session pleine · 03:40 » à la place de la jauge
        let full = AccountGauge(usage: try usage(#"{ "session": { "pct": 100, "resetsAt": "\#(iso)" }, "week": { "pct": 39 } }"#), now: now)
        #expect(full.label == "sem. " + Fmt.pct(39))
        #expect(full.full == "Session pleine · " + Fmt.time(reset))
        #expect(full.pct == 100)
        #expect(full.help.hasPrefix("Session " + Fmt.pct(100) + ", remise à zéro " + Fmt.reset(reset, now: now)))
        #expect(full.help.hasSuffix("Semaine " + Fmt.pct(39)))

        // session au-delà de 90 % : elle passe devant, en orange
        let close = AccountGauge(usage: try usage(#"{ "session": { "pct": 92 }, "week": { "pct": 39 } }"#), now: now)
        #expect(close.label == "session " + Fmt.pct(92))
        #expect(close.warn)
        #expect(close.full == nil)
        #expect(close.pct == 92)

        // d'habitude : la semaine
        let calm = AccountGauge(usage: try usage(#"{ "session": { "pct": 60 }, "week": { "pct": 39 } }"#), now: now)
        #expect(calm.label == "sem. " + Fmt.pct(39))
        #expect(!calm.warn)
        #expect(calm.pct == 39)

        // semaine pleine : elle prime sur tout
        let week = AccountGauge(usage: try usage(#"{ "session": { "pct": 100 }, "week": { "pct": 100 } }"#), now: now)
        #expect(week.full == "Semaine pleine")

        // pas de relevé
        let none = AccountGauge(usage: nil, now: now)
        #expect(none.label == "sem. " + Fmt.none)
        #expect(none.pct == nil)
        #expect(none.help.isEmpty)
    }

    @Test func notificationTextsSayWhatHappensWithoutAnAnswer() throws {
        let json = """
        [ { "id": "g1", "kind": "blocked", "state": "waiting", "pendingId": "p1", "expiresAt": "2026-11-07T10:20:00Z",
            "command": "npx vercel deploy --prod" },
          { "id": "v1", "kind": "blocked", "state": "awaiting", "approvalId": "a1" } ]
        """
        let items = try JSONDecoder().decode([ReviewItem].self, from: Data(json.utf8))
        let expires = try #require(items[0].expiresAt)
        // une heure fixe (le texte est figé), jamais la commande
        #expect(Notifier.sensitiveBody(items[0]) == "Refusée à \(Fmt.time(expires)) sans réponse. Clique pour décider.")
        #expect(!Notifier.sensitiveBody(items[0]).contains("vercel"))
        #expect(Notifier.sensitiveBody(items[1]) == "Elle a continué sans. Autorise-la pour qu'elle la relance.")

        #expect(Notifier.isPlan("Plan à approuver"))
        #expect(Notifier.isPlan("Plan à valider"))
        #expect(!Notifier.isPlan("Quel fond pour la charte ?"))

        let reset = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(Notifier.sessionBody(["Atelier"], reset: reset) == "Atelier va bientôt s'arrêter (remise à zéro à \(Fmt.time(reset)))")
        #expect(Notifier.sessionBody(["Atelier", "Boutique"], reset: nil) == "Atelier et Boutique vont bientôt s'arrêter")
        #expect(Notifier.sessionBody(["Atelier", "Boutique", "Portail/back"], reset: nil)
                == "Atelier, Boutique et Portail/back vont bientôt s'arrêter")
    }

    /// Les données d'exemple dans un dossier temporaire, avec ce que l'essai remplace dans la vue d'ensemble.
    private func store(replacing changes: [String: Any]) async throws -> VigieStore {
        let source = Self.previewFolder.appending(path: "overview.json")
        var overview = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: source)) as? [String: Any])
        for (key, value) in changes { overview[key] = value }
        let folder = FileManager.default.temporaryDirectory.appending(path: "vigie-notifications-\(UUID().uuidString)",
                                                                       directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: overview).write(to: folder.appending(path: "overview.json"))
        let store = VigieStore(client: VigieClient(source: .fixtures(folder)))
        await store.refreshOverview()
        try? FileManager.default.removeItem(at: folder)
        return store
    }

    /// Une bannière seulement pour ce qui demande un geste ; « t'attend » au bout de 20 s, en français, une fois par
    /// attente ; le reste dans le centre de notifications, sans bannière.
    @Test func notificationsAreForWhatNeedsYou() async throws {
        let now = Date.now
        func iso(_ seconds: TimeInterval) -> String { now.addingTimeInterval(seconds).formatted(.iso8601) }
        let toReview: [[String: Any]] = [
            // attentes annoncées par Claude Code (moteur : 20 s au moins, ts = début de l'attente)
            ["id": "c:accord", "kind": "waiting", "conversationId": "accord", "conversationTitle": "Atelier",
             "title": "Attend ton accord dans VS Code", "detail": "Une action à autoriser : Vigie ne l'a pas validée seule.", "ts": iso(-60)],
            ["id": "c:reponse", "kind": "waiting", "conversationId": "reponse", "conversationTitle": "Boutique",
             "title": "Attend ta réponse dans VS Code", "detail": "Une question ou un choix à faire.", "ts": iso(-30)],
            // moteur plus ancien : « en attente » depuis 5 s (la fenêtre que Vigie accepte seule) : pas encore
            ["id": "c:breve", "kind": "waiting", "conversationId": "breve", "conversationTitle": "Portail",
             "title": "Attend ta réponse dans VS Code", "detail": "Refaire l'accueil", "ts": iso(-5)],
            // à agir : question du hook, action sensible, compte changé
            ["id": "w:question:1", "kind": "waiting", "conversationId": "question", "conversationTitle": "Atelier",
             "title": "Quel fond ?", "detail": "Réponds dans VS Code.", "ts": iso(-10)],
            ["id": "g:garde:1", "kind": "blocked", "state": "waiting", "pendingId": "123", "conversationId": "garde",
             "conversationTitle": "Atelier", "title": "Pousser en force", "ts": iso(-2)],
            ["id": "s:bascule:1", "kind": "notice", "conversationId": "bascule", "conversationTitle": "Atelier",
             "title": "Compte changé", "detail": "Écris-lui un message.", "ts": iso(-60)],
            // rien à faire : réponse choisie pour toi, lancée sur un autre compte
            ["id": "q:1", "kind": "question", "conversationId": "atelier", "conversationTitle": "Atelier",
             "title": "Quel fond ?", "ts": iso(-60)],
            ["id": "cf:autre:travail2", "kind": "notice", "conversationId": "autre", "conversationTitle": "Atelier",
             "title": "Lancée sur Perso au lieu de Travail 2", "detail": "Elle reprendra sur Travail 2.", "ts": iso(-60)],
        ]
        let reports: [[String: Any]] = [
            ["kind": "workflowDone", "id": "wf:fini:1", "conversationId": "fini", "conversationTitle": "Atelier",
             "title": "Relecture", "status": "done", "ts": iso(-300)],
            ["kind": "workflowDone", "id": "wf:rate:1", "conversationId": "rate", "conversationTitle": "Atelier",
             "title": "Relecture", "status": "failed", "ts": iso(-300)],
        ]
        let store = try await store(replacing: ["toReview": toReview, "reports": reports])
        let list = Notifier().collect(store)
        func candidate(_ key: String) throws -> Notifier.Candidate { try #require(list.first { $0.key == key }, "\(key) absente") }
        func since(_ id: String) throws -> Date { try #require(store.toReview.first { $0.id == id }?.ts) }
        func stamp(_ id: String) throws -> String { String(Int(try since(id).timeIntervalSince1970)) }

        // « Atelier attend ton accord », l'heure du début de l'attente dans le texte et dans la clé
        let accord = try candidate("r:c:accord:\(try stamp("c:accord"))")
        #expect(accord.title == "Atelier attend ton accord")
        #expect(accord.body == "Une action à autoriser : Vigie ne l'a pas validée seule. En attente depuis \(Fmt.time(try since("c:accord"))).")
        #expect(!accord.quiet)
        let reponse = try candidate("r:c:reponse:\(try stamp("c:reponse"))")
        #expect(reponse.title == "Boutique attend ta réponse")
        #expect(reponse.body.hasPrefix("Une question ou un choix à faire. En attente depuis "))
        // une attente de moins de 20 s ne notifie rien (et n'est pas marquée vue : elle partira plus tard)
        #expect(!list.contains { $0.key.hasPrefix("r:c:breve") })
        #expect(!list.contains { $0.body.contains("permission prompt") || $0.title.contains("t'attend") })
        // texte d'un moteur plus ancien (ce que fait la conversation) : une phrase finie
        let old = try JSONDecoder().decode(ReviewItem.self, from: Data(#"{ "id": "c:x", "detail": "Refaire l'accueil" }"#.utf8))
        #expect(Notifier.waitBody(old) == "Refaire l'accueil.")
        #expect(Notifier.waitTitle(old, conversation: "Portail") == "Portail attend ta réponse")

        // à agir : en bannière
        #expect(try !candidate("r:w:question:1").quiet)
        #expect(try candidate("r:g:garde:1").kind == .sensitive)
        #expect(try !candidate("r:g:garde:1").quiet)
        #expect(try !candidate("r:s:bascule:1").quiet)
        #expect(try candidate("m:wf:rate:1").kind == .stopped)
        #expect(try !candidate("m:wf:rate:1").quiet, "un workflow en échec garde sa bannière")

        // rien à faire : discrètes
        #expect(try candidate("r:q:1").quiet)
        #expect(try candidate("r:cf:autre:travail2").quiet)
        #expect(try candidate("m:wf:fini:1").quiet)
        let day = try #require(list.first { $0.key.hasPrefix("bg:day:") }, "les données d'exemple ont 2 oubliés, 2,1 Go")
        #expect(day.quiet)
    }

    @Test func backAndForwardKeepThePanel() {
        let store = VigieStore(client: VigieClient(source: .fixtures(URL(filePath: "/nonexistent"))))
        #expect(!store.canGoBack)
        store.route = .mcp
        store.route = .conversation("c1")
        store.conversationPanel = .plan
        store.conversationPanelOwner = "c1"
        store.route = .agents
        #expect(store.canGoBack)
        #expect(!store.canGoForward)

        // retour : la conversation se rouvre avec son panneau
        store.goBack()
        #expect(store.route == .conversation("c1"))
        #expect(store.conversationPanel == .plan)
        #expect(store.conversationPanelOwner == "c1")
        #expect(store.canGoForward)
        store.goBack()
        #expect(store.route == .mcp)
        store.goBack()
        #expect(store.route == .overview)
        #expect(!store.canGoBack)

        store.goForward()
        #expect(store.route == .mcp)
        store.goForward()
        #expect(store.route == .conversation("c1"))
        #expect(store.conversationPanel == .plan)

        // une nouvelle page oublie la pile « Suivant »
        store.route = .history
        #expect(!store.canGoForward)

        // 20 pages au plus
        for index in 0..<30 { store.route = .account("compte\(index)") }
        #expect(store.backPages.count == VigieStore.pageHistoryLimit)
    }

    @Test func redBadgeCountsDecisionsOnly() async {
        let store = await demoStore()
        // 8 éléments dans « À regarder » du moteur, 3 décisions : l'action à autoriser, l'accord attendu, l'attente
        #expect(store.toReviewCount == 8)
        #expect(store.decisionCount == 3)
        #expect(store.reviewBadge == 3)
        #expect(store.decisionCount(for: "b1b9b451-c53c-439e-b804-3689257268e3") == 1)
        #expect(store.decisionCount(for: "4e0c8a7d-2f61-4b8e-9c3a-7d5e1f0b9a24") == 0)
    }

    @Test func nextWaitingFollowsTheDeadline() async {
        let store = await demoStore()
        let back = "9a7f3c21-5b8e-4d0a-a6f2-3e1c8b7d4f60"
        let atelier = "b1b9b451-c53c-439e-b804-3689257268e3"
        let front = "c3d2e1f0-8a9b-4c7d-b6e5-1f2a3b4c5d6e"
        // l'échéance la plus proche d'abord, puis la plus récente
        #expect(store.waitingConversationIDs == [back, atelier, front])
        store.showNextWaiting()
        #expect(store.route == .conversation(back))
        store.showNextWaiting()
        #expect(store.route == .conversation(atelier))
        #expect(store.waitingPosition(of: atelier) == "2e des 3")
        #expect(store.waitingPosition(of: back) == "1re des 3")
        store.showNextWaiting()
        store.showNextWaiting()
        #expect(store.route == .conversation(back))
        #expect(store.waitingPosition(of: "4e0c8a7d-2f61-4b8e-9c3a-7d5e1f0b9a24") == nil)
    }

    @Test func openingADecisionGoesToItsConversation() async throws {
        let store = await demoStore()
        let blocked = try #require(store.toReview.first { $0.id.hasPrefix("g:") })
        store.open(review: blocked)
        #expect(store.route == .conversation("9a7f3c21-5b8e-4d0a-a6f2-3e1c8b7d4f60"))
        #expect(store.blockedRequest == blocked)

        // « t'attend » : la conversation seule
        store.blockedRequest = nil
        let waiting = try #require(store.toReview.first { $0.reviewKind == .waiting })
        store.open(review: waiting)
        #expect(store.route == .conversation("c3d2e1f0-8a9b-4c7d-b6e5-1f2a3b4c5d6e"))
        #expect(store.blockedRequest == nil)
        #expect(store.answerRequest == nil)
    }

    /// « Voir le rapport » d'un agent de Vigie : la page de SA conversation, panneau Rapport ouvert (plus la page
    /// Agents) ; Retour ramène à la page d'avant avec son propre panneau.
    @Test func agentReportOpensInItsConversation() async throws {
        let store = await demoStore()
        let boutique = "4e0c8a7d-2f61-4b8e-9c3a-7d5e1f0b9a24"
        let atelier = "b1b9b451-c53c-439e-b804-3689257268e3"
        store.route = .conversation(atelier)
        store.conversationPanelOwner = atelier
        store.conversationPanel = .plan

        store.showAgentReport(boutique)
        #expect(store.route == .conversation(boutique))
        #expect(store.conversationPanel == .report)
        #expect(store.conversationPanelOwner == boutique)

        // retour : Atelier et son plan ; suivant : le rapport de Boutique
        store.goBack()
        #expect(store.route == .conversation(atelier))
        #expect(store.conversationPanel == .plan)
        store.goForward()
        #expect(store.route == .conversation(boutique))
        #expect(store.conversationPanel == .report)

        // déjà sur la page : le panneau s'ouvre, la page ne s'empile pas une seconde fois
        store.conversationPanel = nil
        let back = store.backPages.count
        store.showAgentReport(boutique)
        #expect(store.conversationPanel == .report)
        #expect(store.backPages.count == back)
    }

    /// Le rapport dans la page de sa conversation : une action cochée l'est tout de suite ; « Retirer ce rapport »
    /// fait partir la tuile et ferme le panneau.
    @Test func agentReportChangesShowAtOnce() async throws {
        let store = await demoStore()
        let boutique = "4e0c8a7d-2f61-4b8e-9c3a-7d5e1f0b9a24"
        await store.refreshConversation(boutique)
        let run = try #require(store.details[boutique]?.raw.agentRun)
        #expect(run.conversation == boutique && run.folder == "/Users/alex/Code/boutique")
        // la tuile a de quoi dire : un verdict, une suite proposée, des actions à toi dont une déjà faite
        #expect(run.report?.verdict != nil && run.report?.next.isEmpty == false)
        #expect(RecipeRunState(run.report) == .blocked)
        let todo = try #require(run.report?.todo.first { !$0.done })
        #expect(AgentReportPanel.todoLine(run.report?.todo ?? []) == "1/3 faites")

        await store.setAgentTodo(run, todo, done: true, in: boutique)
        let checked = try #require(store.details[boutique]?.raw.agentRun)
        #expect(checked.report?.todo.first { $0.index == todo.index }?.done == true)
        #expect(AgentReportPanel.todoLine(checked.report?.todo ?? []) == "2/3 faites")

        store.showAgentReport(boutique)
        await store.hideAgentRun(checked, in: boutique)
        #expect(store.details[boutique]?.raw.agentRun == nil)
        #expect(store.conversationPanel == nil)
        #expect(store.route == .conversation(boutique))

        // le moteur refuse : la tuile revient, et le panneau Rapport qui était ouvert se rouvre
        store.undoHideAgentRun(checked, in: boutique, reopenPanel: true)
        #expect(store.details[boutique]?.raw.agentRun?.id == checked.id)
        #expect(store.conversationPanel == .report)
        // un autre panneau a pris sa place entre-temps : il reste
        await store.hideAgentRun(checked, in: boutique)
        store.conversationPanel = .plan
        store.undoHideAgentRun(checked, in: boutique, reopenPanel: true)
        #expect(store.details[boutique]?.raw.agentRun?.id == checked.id)
        #expect(store.conversationPanel == .plan)
        // le panneau était fermé au retrait : il ne s'ouvre pas tout seul
        store.conversationPanel = nil
        await store.hideAgentRun(checked, in: boutique)
        store.undoHideAgentRun(checked, in: boutique, reopenPanel: false)
        #expect(store.conversationPanel == nil)
    }
}
