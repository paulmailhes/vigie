import Foundation
import Testing
@testable import Vigie

/// Les pages d'outils : ordre des comptes, mauvaise adresse, « jusqu'où tient chaque compte », avertissement au
/// lancement d'un agent, « À régler » des MCP, mots de l'Historique.
@MainActor
struct ToolPagesTests {
    /// Les données d'exemple du dépôt (mac/VigieApp/Preview).
    private static var previewFolder: URL {
        URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Preview", directoryHint: .isDirectory)
    }

    private func accounts(_ json: String) throws -> [Account] {
        try JSONDecoder().decode([Account].self, from: Data(json.utf8))
    }

    private func week(_ json: String) throws -> UsageWindow {
        try JSONDecoder().decode(UsageWindow.self, from: Data(json.utf8))
    }

    /// Une date en heure locale, en octobre 2026 (mardi 20, jeudi 22, lundi 26).
    private func date(_ day: Int, _ hour: Int, _ minute: Int = 0) throws -> Date {
        try #require(Calendar.current.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute)))
    }

    private func iso(_ date: Date) -> String { date.formatted(.iso8601) }

    // MARK: Comptes

    @Test func accountsWithAProblemComeFirst() throws {
        let list = try accounts("""
        [ { "id": "travail1", "label": "Travail 1", "connected": true },
          { "id": "travail2", "label": "Travail 2", "connected": false },
          { "id": "codex", "kind": "codex", "connected": false },
          { "id": "perso", "label": "Perso", "connected": true, "wrongAccount": true },
          { "id": "double", "label": "Atelier", "connected": true, "sameAs": ["travail1"] } ]
        """)
        // mauvaise adresse, doublon, pas connecté d'abord, dans l'ordre du moteur ; Codex pas connecté n'en est pas un
        #expect(AccountsView.ordered(list).map(\.id) == ["travail2", "perso", "double", "travail1", "codex"])
        #expect(AccountsView.ordered([]).isEmpty)
    }

    @Test func wrongAddressSaysBothAddresses() throws {
        let list = try accounts("""
        [ { "id": "a", "email": "bob@autre.fr", "expectedEmail": "alex@perso-exemple.fr", "wrongAccount": true, "connected": true },
          { "id": "b", "email": "alex@perso-exemple.fr", "expectedEmail": "Alex@Perso-Exemple.fr", "wrongAccount": true, "connected": true },
          { "id": "c", "email": "bob@autre.fr", "wrongAccount": true, "connected": true },
          { "id": "d", "wrongAccount": true, "connected": true },
          { "id": "e", "email": "alex@perso-exemple.fr", "expectedEmail": "alex@perso-exemple.fr", "connected": true } ]
        """)
        #expect(AccountCard.wrongAddressText(list[0]) == "Connecté avec bob@autre.fr. Adresse prévue : alex@perso-exemple.fr.")
        #expect(AccountCard.address(list[0]) == "bob@autre.fr")
        // l'adresse prévue recopiée n'est pas l'adresse connectée : on ne la montre pas comme telle
        #expect(AccountCard.wrongAddressText(list[1]) == "Connecté avec une autre adresse que Alex@Perso-Exemple.fr.")
        #expect(AccountCard.address(list[1]) == "Adresse différente de celle prévue")
        #expect(AccountCard.wrongAddressText(list[2]) == "Connecté avec bob@autre.fr, pas avec l'adresse prévue.")
        #expect(AccountCard.wrongAddressText(list[3]) == "Connecté avec une autre adresse que celle prévue.")
        #expect(AccountCard.address(list[4]) == "alex@perso-exemple.fr")
        #expect(SidebarAccountRow.wrongAddressHelp == "Mauvaise adresse : reconnecte-le dans Comptes")
    }

    @Test func previewShowsAWrongAddressAndOneForecast() throws {
        let data = try Data(contentsOf: Self.previewFolder.appending(path: "accounts.json"))
        let state = try JSONDecoder().decode(AccountsState.self, from: data)
        let wrong = try #require(state.accounts.first { $0.wrongAccount == true })
        #expect(AccountCard.wrongAddressText(wrong) == "Connecté avec bob@autre.fr. Adresse prévue : alex@perso-exemple.fr.")
        // un seul compte qui serait plein avant la remise à zéro, et c'est avant elle
        let forecasts = state.accounts.filter { $0.usage?.week?.fullAt != nil }
        #expect(forecasts.map(\.id) == ["travail1"])
        let week = try #require(forecasts.first?.usage?.week)
        let full = try #require(week.fullAt)
        let reset = try #require(week.resetsAt)
        #expect(full < reset)
        #expect(Calendar.current.component(.weekday, from: full) == 5, "un jeudi")
        // la vue d'ensemble dit la même chose que la page Comptes (adresse, prévision de la semaine)
        let overview = try JSONDecoder().decode(Overview.self, from: Data(contentsOf: Self.previewFolder.appending(path: "overview.json")))
        for account in overview.accounts {
            let same = try #require(state.accounts.first { $0.id == account.id })
            #expect(account.email == same.email && account.expectedEmail == same.expectedEmail, "\(account.id)")
            #expect(account.usage?.week?.fullAt == same.usage?.week?.fullAt, "\(account.id)")
        }
    }

    // MARK: Jusqu'où tient chaque compte

    @Test func weekForecastSaysWhenItWouldBeFull() throws {
        let now = try date(20, 21)   // mardi soir
        let reset = iso(try date(26, 20)), full = iso(try date(22, 13, 45))
        let window = try week(#"{ "pct": 62, "resetsAt": "\#(reset)", "fullAt": "\#(full)" }"#)
        #expect(WeekForecast.text(window, now: now) == "À ce rythme : semaine pleine vers jeu. 14\u{00A0}h, avant la remise à zéro de lun.\u{00A0}20:00")
        // sous la jauge de la page Comptes, qui écrit déjà la remise à zéro : la première moitié
        #expect(WeekForecast.text(window, now: now, withReset: false) == "À ce rythme : semaine pleine vers jeu. 14\u{00A0}h")
        #expect(WeekForecast.notificationTitle(account: "Travail 1", week: window, now: now)
                == "Travail 1 sera plein avant la remise à zéro (vers jeu. 14\u{00A0}h)")

        // à l'heure ronde, demain ou aujourd'hui
        #expect(WeekForecast.approx(try date(22, 14, 15), now: now) == "vers jeu. 14\u{00A0}h")
        #expect(WeekForecast.approx(try date(22, 13, 30), now: now) == "vers jeu. 14\u{00A0}h")
        #expect(WeekForecast.approx(try date(21, 8), now: now) == "demain vers 8\u{00A0}h")
        #expect(WeekForecast.approx(try date(21, 23, 45), now: now) == "vers jeu. 0\u{00A0}h")
        #expect(WeekForecast.approx(try date(20, 17, 10), now: try date(20, 9)) == "vers 17\u{00A0}h")
        // dans moins d'une heure : un délai à l'écran, une heure dans une notification (texte figé)
        let soon = now.addingTimeInterval(25 * 60)
        #expect(WeekForecast.approx(soon, now: now) == "dans 25 min")
        #expect(WeekForecast.approx(soon, now: now, fixed: true) == "vers \(Fmt.time(soon))")
        // le même jour de la semaine, 7 jours plus tard : la date entière
        #expect(WeekForecast.approx(try date(26, 22), now: try date(19, 21)).hasSuffix("26 oct. 22\u{00A0}h"))

        #expect(WeekForecast.resetDay(try date(20, 23), now: now) == "à 23:00")
        #expect(WeekForecast.resetDay(try date(21, 20), now: now) == "de demain 20:00")
        #expect(WeekForecast.resetDay(try date(26, 20), now: try date(19, 21)).hasSuffix("26 oct.\u{00A0}20:00"))

        // sans remise à zéro connue : la première moitié seulement
        let noReset = try week(#"{ "pct": 62, "fullAt": "\#(full)" }"#)
        #expect(WeekForecast.text(noReset, now: now) == "À ce rythme : semaine pleine vers jeu. 14\u{00A0}h")
    }

    @Test func weekForecastSaysNothingWhenItHolds() throws {
        let now = try date(20, 21)
        let reset = iso(try date(26, 20)), earlier = iso(try date(20, 14)), after = iso(try date(27, 9))
        // le moteur ne la voit pas pleine (ou n'a pas de quoi mesurer) : rien, jamais « tient » à sa place
        #expect(WeekForecast.text(try week(#"{ "pct": 30, "resetsAt": "\#(reset)", "fullAt": null }"#), now: now) == nil)
        #expect(WeekForecast.text(try week(#"{ "pct": 30, "resetsAt": "\#(reset)" }"#), now: now) == nil)
        #expect(WeekForecast.text(nil, now: now) == nil)
        // déjà pleine : la jauge le dit (« Semaine pleine »)
        #expect(WeekForecast.text(try week(#"{ "pct": 100, "resetsAt": "\#(reset)", "fullAt": "\#(earlier)" }"#), now: now) == nil)
        // une date passée ou après la remise à zéro ne veut rien dire ici
        #expect(WeekForecast.text(try week(#"{ "pct": 90, "resetsAt": "\#(reset)", "fullAt": "\#(earlier)" }"#), now: now) == nil)
        #expect(WeekForecast.text(try week(#"{ "pct": 50, "resetsAt": "\#(reset)", "fullAt": "\#(after)" }"#), now: now) == nil)
        #expect(WeekForecast.notificationTitle(account: "Perso", week: nil, now: now) == nil)
    }

    @Test func weekForecastReachesTheSidebarAndTheNotification() throws {
        let now = try date(20, 21)
        let reset = try date(26, 20)
        let full = iso(try date(22, 13, 45))
        let usage = try JSONDecoder().decode(AccountUsage.self, from: Data("""
        { "session": { "pct": 20 }, "week": { "pct": 62, "resetsAt": "\(iso(reset))", "fullAt": "\(full)" } }
        """.utf8))
        let gauge = AccountGauge(usage: usage, now: now)
        let text = "À ce rythme : semaine pleine vers jeu. 14\u{00A0}h, avant la remise à zéro de lun.\u{00A0}20:00"
        #expect(gauge.forecast == text)
        #expect(gauge.help.hasSuffix("\n" + text))
        #expect(AccountGauge(usage: nil, now: now).forecast == nil)

        // une seule notification par compte et par semaine : la remise à zéro à l'heure près fait la clé
        #expect(Notifier.forecastKey(accountId: "travail1", reset: reset, now: now)
                == Notifier.forecastKey(accountId: "travail1", reset: reset.addingTimeInterval(-40), now: now))
        #expect(Notifier.forecastKey(accountId: "travail1", reset: reset, now: now)
                != Notifier.forecastKey(accountId: "travail1", reset: reset.addingTimeInterval(7 * 86_400), now: now))
        #expect(Notifier.forecastKey(accountId: "travail1", reset: reset, now: now).hasPrefix("f:travail1:"))
        #expect(NotifyKind.accountWeek.title.contains("sera plein avant la remise à zéro"))
    }

    @Test func accountAlertKeysDoNotMoveWithTheReading() throws {
        let now = try date(20, 1)
        // la remise à zéro lue oscille autour de l'heure ronde : une seule alerte
        let reset = try date(26, 20)
        #expect(Notifier.weekKey(accountId: "travail1", threshold: 90, reset: reset.addingTimeInterval(-1))
                == Notifier.weekKey(accountId: "travail1", threshold: 90, reset: reset))
        #expect(Notifier.weekKey(accountId: "travail1", threshold: 90, reset: reset)
                != Notifier.weekKey(accountId: "travail1", threshold: 80, reset: reset))
        #expect(Notifier.weekKey(accountId: "travail1", threshold: 90, reset: reset)
                != Notifier.weekKey(accountId: "travail1", threshold: 90, reset: reset.addingTimeInterval(7 * 86_400)))
        let session = try date(21, 4)
        #expect(Notifier.sessionKey(accountId: "travail1", reset: session.addingTimeInterval(-0.2), now: now)
                == Notifier.sessionKey(accountId: "travail1", reset: session.addingTimeInterval(0.2), now: now))
        #expect(Notifier.sessionKey(accountId: "travail1", reset: session, now: now)
                != Notifier.sessionKey(accountId: "travail1", reset: session.addingTimeInterval(5 * 3600), now: now))
    }

    // MARK: Lancement d'un agent

    @Test func agentLaunchWarnsWhenTheAccountIsAlmostFull() throws {
        let now = try date(20, 1)
        let reset = try date(20, 3, 40)
        let list = try accounts("""
        [ { "id": "travail1", "label": "Travail 1", "connected": true,
            "usage": { "session": { "pct": 100, "resetsAt": "\(iso(reset))" }, "week": { "pct": 40 } } },
          { "id": "travail2", "label": "Travail 2", "connected": false },
          { "id": "bob", "label": "Atelier", "connected": true, "wrongAccount": true, "usage": { "week": { "pct": 1 } } },
          { "id": "perso", "label": "Perso", "connected": true, "usage": { "session": { "pct": 10 }, "week": { "pct": 20 } } },
          { "id": "codex", "kind": "codex", "connected": true } ]
        """)
        let head = "Travail 1 est à \(Fmt.pct(100)) de sa session (remise à zéro \(Fmt.reset(reset, now: now)))."
        let warning = try #require(AgentAccountWarning.warning(accountID: "travail1", accounts: list, now: now))
        // le compte qui a le plus de marge, bien connecté (jamais la mauvaise adresse, ni Codex)
        #expect(warning.text == head + " Perso a plus de marge.")
        #expect(warning.roomiest?.id == "perso")
        #expect(AgentAccountWarning.text(accountID: "travail1", accounts: list, now: now) == warning.text)

        // de la marge : rien
        #expect(AgentAccountWarning.warning(accountID: "perso", accounts: list, now: now) == nil)
        #expect(AgentAccountWarning.warning(accountID: nil, accounts: list, now: now) == nil)
        // la session déjà remise à zéro : son ancien chiffre ne compte plus
        #expect(AgentAccountWarning.warning(accountID: "travail1", accounts: list, now: try date(20, 4)) == nil)

        // la semaine presque pleine, aucun autre compte avec de la marge : la phrase seule, pas de bouton
        let alone = try accounts("""
        [ { "id": "travail1", "label": "Travail 1", "connected": true, "usage": { "week": { "pct": 92 } } },
          { "id": "perso", "label": "Perso", "connected": true, "usage": { "week": { "pct": 95 } } } ]
        """)
        let full = try #require(AgentAccountWarning.warning(accountID: "travail1", accounts: alone, now: now))
        #expect(full.text == "Travail 1 est à \(Fmt.pct(92)) de sa semaine.")
        #expect(full.roomiest == nil)
    }

    @Test func agentLaunchAccountIsTheDefaultForNewConversations() async {
        let store = VigieStore(client: VigieClient(source: .fixtures(Self.previewFolder)))
        await store.refreshOverview()
        let account = AgentAccountWarning.launchAccount(store)
        #expect(account?.id == "travail1")
        #expect(account?.name == "Travail 1")
    }

    @Test func focusedRunOpensWithTheOthers() throws {
        let runs = try JSONDecoder().decode([RecipeRun].self, from: Data("""
        [ { "id": "r1", "agent": "site", "folder": "/Users/alex/Code/atelier" },
          { "id": "r2", "agent": "site", "folder": "/Users/alex/Code/boutique" } ]
        """.utf8))
        // rien de touché : le plus récent reste ouvert, le rapport demandé s'ouvre en plus
        #expect(RecipeRunsSection.opening("r2", in: nil, runs: runs) == ["r1", "r2"])
        #expect(RecipeRunsSection.opening("r2", in: [], runs: runs) == ["r2"])
        #expect(RecipeRunsSection.anchor("r2") == "run:r2")
    }

    // MARK: MCP

    @Test func mcpFixesGatherWhatNeedsAGesture() throws {
        let list = try accounts("""
        [ { "id": "travail1", "label": "Travail 1", "connected": true },
          { "id": "perso", "label": "Perso", "connected": true },
          { "id": "travail2", "label": "Travail 2", "connected": false },
          { "id": "codex", "kind": "codex", "connected": true } ]
        """)
        let mcp = try JSONDecoder().decode(MCPState.self, from: Data("""
        { "user": [
            { "name": "figma-pro", "service": "figma", "accounts": ["travail1", "perso"],
              "health": [ { "accountId": "travail1", "status": "needs-auth" },
                          { "accountId": "perso", "status": "failed", "message": "Délai dépassé" } ] },
            { "name": "notion", "accounts": ["travail1"], "health": [ { "accountId": "travail1", "status": "connected" } ] },
            { "name": "webflow", "service": "webflow" },
            { "name": "linear", "needsAuth": true } ],
          "projects": [ { "path": "/Users/alex/Code/portail", "name": "portail",
                          "servers": [ { "name": "supabase", "health": [ { "accountId": "travail1", "status": "pending-approval" } ] } ] } ],
          "local": [],
          "connectors": [ { "name": "Gmail", "accountId": "perso", "health": [ { "accountId": "perso", "status": "needs-auth" } ] } ],
          "gateway": { "webflow": { "open": false, "profiles": [] } } }
        """.utf8))
        let fixes = MCPFix.all(in: mcp, accounts: list)
        // dans l'ordre de la page : MCP du Mac (en échec avant à connecter), projets, MCP du compte ; « notion »,
        // absent de Perso, est une remarque sous le MCP, pas une chose à régler
        #expect(fixes.map(\.kind) == [.failed, .connect, .gateway, .verify, .approve, .connect])
        #expect(fixes.map(\.name) == ["figma-pro", "figma-pro", "webflow", "linear", "supabase", "Gmail"])
        #expect(fixes.map(\.text) == ["En échec sur Perso", "À connecter sur Travail 1",
                                      "Pas encore connecté : une seule connexion pour tous tes comptes",
                                      "À connecter, pas encore vérifié sur tes comptes",
                                      "À approuver dans Claude Code, sur Travail 1", "À connecter sur Perso"])
        #expect(fixes[0].message == "Délai dépassé")
        #expect(fixes[0].origin == Theme.title(for: .mac))
        #expect(fixes[4].path == "/Users/alex/Code/portail")
        #expect(fixes[4].origin == mcp.projects[0].displayName)
        #expect(fixes[5].origin == "MCP du compte")
        // une ligne par chose à régler
        #expect(Set(fixes.map(\.id)).count == fixes.count)
    }

    // MARK: Historique

    @Test func historySaysRefusedOnItsOwn() {
        #expect(HistoryStatus.blocked.title == "Refusées d'office")
        #expect(HistoryStatus.blocked.label == "Refusée d'office")
        #expect(HistoryStatus.failed.label == "En échec")
        #expect(HistoryStatus.allCases.allSatisfy { !$0.title.contains("Bloqu") && !$0.label.contains("Bloqu") })
        // le rouge pour ce qui n'est pas passé sans toi ou t'attend ; jamais de vert pour « acceptée »
        #expect(HistoryStatus.blocked.tone == .alert && HistoryStatus.failed.tone == .alert && HistoryStatus.waiting.tone == .alert)
        #expect(HistoryStatus.accepted.tone == .neutral)
        // accepter, c'est Vigie seule ; autoriser, c'est toi ; un statut inconnu reste lisible
        #expect(HistoryStatus.accepted.label == "Acceptée" && HistoryStatus.allowed.label == "Autorisée")
        #expect(HistoryStatus.allowed.title == "Autorisées" && HistoryStatus.allowed.tone == .neutral)
    }
}
