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
        #expect(store.waitingPosition(of: atelier) == "2 sur 3")
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
        let waiting = try #require(store.toReview.first { $0.id.hasPrefix("w:") })
        store.open(review: waiting)
        #expect(store.route == .conversation("c3d2e1f0-8a9b-4c7d-b6e5-1f2a3b4c5d6e"))
        #expect(store.blockedRequest == nil)
        #expect(store.answerRequest == nil)
    }
}
