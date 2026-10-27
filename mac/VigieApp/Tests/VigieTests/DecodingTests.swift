import Foundation
import Testing
@testable import Vigie

/// Le contrat avec le moteur (docs/api-v2.md) : décodage tolérant, exemples, réponses réelles du moteur.
struct DecodingTests {
    private static let packageRoot = URL(filePath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    @Test func toleratesMissingNullAndBrokenFields() throws {
        let json = """
        { "now": "2026-10-20T01:14:00Z", "since": 1760917200000,
          "settings": { "autoAccept": true, "guard": null },
          "sinceSummary": "oups",
          "toReview": [ { "id": "q:1", "kind": "question", "ts": "2026-10-20T01:14:00.123Z",
                          "question": { "id": "1", "items": [ { "question": "Q ?", "options": [ {"label": "A"}, 42, {"label": "B"} ],
                                                                "chosen": ["A", "B"] } ] } },
                        { "kind": "blocked" },
                        { "id": "w:2", "kind": "nouveau-type", "ts": "pas une date" } ],
          "reports": null,
          "accounts": [ { "id": "t1", "wrongAccount": true,
                          "usage": { "week": { "pct": 39, "resetsAt": "2026-10-26T19:00:00+01:00" }, "observedAt": null } } ],
          "conversations": [ { "id": "c1", "status": "busy", "weekPct": 14 }, { "title": "sans id" } ],
          "engine": { "notices": ["Indexation en cours", { "message": "Nouvelle version" }, 3] },
          "champInconnu": { "x": 1 } }
        """
        let overview = try JSONDecoder().decode(Overview.self, from: Data(json.utf8))
        #expect(overview.now != nil)
        #expect(abs((overview.since?.timeIntervalSince1970 ?? 0) - 1_760_917_200) < 1)
        #expect(overview.settings?.autoAccept == true)
        #expect(overview.settings?.guardRules == nil)
        #expect(overview.sinceSummary == nil)
        #expect(overview.toReview.count == 2)
        #expect(overview.toReview.first?.ts != nil)
        #expect(overview.toReview.first?.question?.items.first?.options.count == 2)
        #expect(overview.toReview.first?.question?.items.first?.chosenLabels == ["A", "B"])
        #expect(overview.toReview.first?.questionID == "1")
        #expect(overview.toReview.last?.ts == nil)
        #expect(overview.toReview.last?.reviewKind == .other)
        #expect(overview.reports.isEmpty)
        #expect(overview.accounts.first?.usage?.week?.resetsAt != nil)
        #expect(overview.accounts.first?.wrongAccount == true)
        #expect(overview.conversations.count == 1)
        #expect(overview.conversations.first?.state == .working)
        #expect(overview.engine?.notices.map(\.text) == ["Indexation en cours", "Nouvelle version"])
    }

    @Test func decodesPlanAndFreshness() throws {
        let json = """
        { "summary": { "id": "c1" },
          "now": { "text": "…", "ts": "2026-10-20T01:14:00Z", "tasks": [], "tasksTs": "2026-10-20T01:10:00.000Z",
                   "plan": { "title": "Plan d'exécution 1.4", "updatedAt": "2026-10-20T00:41:00Z",
                             "steps": [ { "id": "L2.23", "text": "Jauge", "status": "done", "group": "C" },
                                        { "id": "L2.24", "text": "Icônes", "status": "doing", "group": "C" },
                                        { "id": "L2.25", "status": "todo" }, 7 ],
                             "current": "L2.24" } } }
        """
        let detail = try JSONDecoder().decode(ConversationDetail.self, from: Data(json.utf8))
        let plan = try #require(detail.now?.plan)
        #expect(detail.now?.tasksTs != nil)
        #expect(plan.updatedAt != nil)
        #expect(plan.steps.count == 3)
        #expect(plan.doneCount == 1)
        #expect(plan.totalCount == 3)
        #expect(plan.currentIndex == 1)
        #expect(plan.steps[1].label == "L2.24 Icônes")
        #expect(plan.steps[2].label == "L2.25")

        let usage = try JSONDecoder().decode(AccountUsage.self, from: Data("""
        { "session": null, "week": { "pct": 8 }, "observedAt": "2026-10-19T20:05:00Z", "source": "ping" }
        """.utf8))
        #expect(usage.session == nil)
        #expect(usage.week?.pct == 8)
        #expect(usage.source == "ping")
    }

    @Test func decodesPreviewFiles() throws {
        try decodeFolder(Self.packageRoot.appending(path: "Preview"), required: true)
    }

    private func decodeFolder(_ folder: URL, required: Bool) throws {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        if required { #expect(names.contains("overview.json")) }
        let decoder = JSONDecoder()
        for name in names where name.hasSuffix(".json") {
            let data = try Data(contentsOf: folder.appending(path: name))
            switch name {
            case "overview.json":
                let overview = try decoder.decode(Overview.self, from: data)
                #expect(!overview.conversations.isEmpty, "\(name)")
            case "mcp.json":
                let mcp = try decoder.decode(MCPState.self, from: data)
                #expect(!mcp.user.isEmpty, "\(name)")
            case "accounts.json":
                let accounts = try decoder.decode(AccountsState.self, from: data)
                #expect(!accounts.accounts.isEmpty, "\(name)")
            case "agents.json":
                let agents = try decoder.decode(AgentLibrary.self, from: data)
                #expect(agents.agents.contains { $0.canLaunch && !$0.fields.isEmpty && !$0.mcp.isEmpty }, "\(name)")
                #expect(agents.agents.contains { !$0.canLaunch }, "\(name)")
                // la feuille des captures : un agent à un seul long texte, qui dit ce qu'il crée
                #expect(agents.agents.contains { $0.canLaunch && $0.fields.count == 1 && $0.dropField != nil && !$0.willCreate.isEmpty },
                        "\(name)")
                #expect(agents.surfaces?.available == [.vscode, .claudeApp], "\(name)")
            case "agents-folder.json":
                let folder = try decoder.decode(AgentFolderInfo.self, from: data)
                #expect(folder.exists && folder.problem == nil, "\(name)")
                #expect(!folder.resumable.isEmpty && !folder.sources.isEmpty, "\(name)")
            case let usage where usage.hasPrefix("usage-series-"):
                let series = try decoder.decode(UsageSeries.self, from: data)
                #expect(!series.conversations.isEmpty, "\(name)")
                #expect(series.conversations.allSatisfy { $0.points.allSatisfy { $0.t != nil } }, "\(name)")
            default:
                let detail = try decoder.decode(ConversationDetail.self, from: data)
                #expect(detail.summary != nil, "\(name)")
            }
        }
    }

    /// Tour 3 : consommation, alerte « s'emballe », actions sensibles « seulement par Vigie ».
    @Test func decodesRoundThreeFields() throws {
        let json = """
        { "settings": { "guard": { "enabled": true, "mode": "vigie", "rules": [] } },
          "toReview": [ { "id": "a:1", "kind": "blocked", "state": "awaiting", "approvalId": 42, "command": "sudo ls" },
                        { "id": "g:2", "kind": "blocked", "state": "waiting", "pendingId": "9" } ],
          "conversations": [
            { "id": "c1", "rate": { "weekPctPerHour": 1.2, "tokensPerMin": 48000, "spark": [0, 0.4, null, 1.1], "trend": "up" },
              "alert": { "kind": "emballe", "since": "2026-10-20T01:14:00Z", "reason": "Boucle" } },
            { "id": "c2", "rate": "oups", "alert": null } ] }
        """
        let overview = try JSONDecoder().decode(Overview.self, from: Data(json.utf8))
        // « mode » n'existe plus (actions sensibles toujours dans la conversation et dans Vigie) : ignoré, le reste se lit
        #expect(overview.settings?.guardRules?.enabled == true)
        #expect(overview.toReview.first?.approvalId == "42")
        #expect(overview.toReview.first?.isAwaitingApproval == true)
        #expect(overview.toReview.first?.needsDecision == true)
        #expect(overview.toReview.last?.isAwaitingApproval == false)
        #expect(overview.toReview.last?.needsDecision == true)
        let first = overview.conversations.first
        #expect(first?.rate?.weekPctPerHour == 1.2)
        #expect(first?.rate?.spark == [0, 0.4, 1.1])
        #expect(first?.alert?.isRunaway == true)
        #expect(first?.alert?.since != nil)
        #expect(overview.conversations.last?.rate == nil)
        #expect(overview.conversations.last?.alert == nil)

        let series = try JSONDecoder().decode(UsageSeries.self, from: Data("""
        { "stepMin": 10, "conversations": [ { "id": "c1", "points": [ { "t": "2026-10-20T01:00:00Z", "weekPct": 0.5, "tokens": 1000 },
                                                                    { "t": "2026-10-20T01:10:00Z", "weekPct": 0.25 }, 3 ] },
                                            { "title": "sans id" } ],
          "accounts": null }
        """.utf8))
        #expect(series.conversations.count == 1)
        #expect(series.conversations.first?.totalPct == 0.75)
        #expect(series.conversations.first?.totalTokens == 1000)
        #expect(series.accounts.isEmpty)
    }

    /// GET /api/v2/agents : un champ, un MCP ou un agent illisible ne fait pas tomber la liste.
    @Test func decodesAgentsTolerantly() throws {
        let json = """
        { "account": "oups",
          "agents": [
            { "id": "demarrer-projet", "name": "Démarrer un projet client", "icon": "wand.and.stars", "folder": "/Users/alex/Code",
              "fields": [ { "id": "client", "label": "Nom du client", "type": "text", "required": true, "help": "", "placeholder": "Cabinet Martin" },
                          { "id": "refs", "type": "urls", "required": "oui" },
                          { "id": "notes", "label": "Notes", "type": "dessin" },
                          { "label": "sans id" }, 7 ],
              "mcp": [ { "name": "figma-pro", "status": "connected" }, { "name": "webflow-pro", "status": "needs-auth" },
                       "obsidian", { "name": "x", "status": "nouvel-etat" }, { "status": "connected" } ],
              "error": null, "champInconnu": 1 },
            { "id": "casse", "fields": null, "mcp": null, "error": "AGENT.md illisible : il manque la ligne « --- »." },
            { "name": "sans id" } ] }
        """
        let state = try JSONDecoder().decode(AgentLibrary.self, from: Data(json.utf8))
        #expect(state.account == nil)
        #expect(state.agents.map(\.id) == ["demarrer-projet", "casse"])

        let agent = try #require(state.agents.first)
        #expect(agent.canLaunch)
        #expect(agent.fields.map(\.id) == ["client", "refs", "notes"])
        #expect(agent.fields[0].required && agent.fields[0].help == nil && agent.fields[0].placeholder == "Cabinet Martin")
        #expect(agent.fields[1].kind == .urls && !agent.fields[1].required && agent.fields[1].label == "refs")
        #expect(agent.fields[2].kind == .text)
        #expect(agent.mcp.map(\.name) == ["figma-pro", "webflow-pro", "obsidian", "x"])
        #expect(agent.mcp.map(\.mcpStatus) == [.connected, .needsAuth, .unknown, .unknown])
        #expect(agent.mcpToFix.map(\.name) == ["webflow-pro"])
        #expect(agent.namingField?.id == "client")

        let broken = state.agents[1]
        #expect(!broken.canLaunch)
        #expect(broken.displayName == "casse")
        #expect(broken.fields.isEmpty && broken.mcp.isEmpty)

        let account = try JSONDecoder().decode(AgentLibrary.self, from: Data("""
        { "account": { "id": "travail1", "label": "Travail 1" }, "agents": [] }
        """.utf8)).account
        #expect(account?.displayName == "Travail 1")
    }

    /// Un MCP demandé par son service : « Figma » quel que soit le nom du MCP trouvé, celui utilisé à côté ; aucun : à
    /// ajouter d'ici ; un autre choisi dans le formulaire : son état et ce qui se connecte d'ici suivent.
    @Test func decodesAgentMCPByService() throws {
        let mcp = try JSONDecoder().decode([AgentMCP].self, from: Data("""
        [ { "name": "figma", "service": "figma", "status": "connected", "chosen": "figma-pro", "connect": "figma-pro",
            "servers": [ { "name": "figma-pro", "status": "connected", "connect": true },
                         { "name": "Figma", "status": "needs-auth", "connect": true }, "oups", { "status": "connected" } ] },
          { "name": "figma", "service": "figma", "status": "missing", "servers": [], "chosen": null, "connect": null },
          { "name": "Gmail", "service": "gmail", "status": "needs-auth", "chosen": "Gmail", "connect": "Gmail",
            "servers": [ { "name": "Gmail", "status": "needs-auth", "connect": true } ] },
          { "name": "webflow-pro", "service": "webflow", "status": "needs-auth", "chosen": "webflow-pro", "connect": null,
            "servers": [ { "name": "webflow-pro", "status": "needs-auth", "connect": false } ] },
          { "name": "outil-maison", "status": "connected", "servers": "oups" } ]
        """.utf8))
        #expect(mcp.map(\.title) == ["Figma", "Figma", "Gmail", "Webflow", "outil-maison"])
        #expect(mcp[0].servers.map(\.name) == ["figma-pro", "Figma"] && !mcp[0].isMissing && mcp[0].key == "figma")
        #expect(mcp[0].chosenDetail == "figma-pro" && mcp[2].chosenDetail == nil, "le nom ne se répète pas quand il dit le service")
        let other = mcp[0].picking("Figma")
        #expect(other.chosen == "Figma" && other.mcpStatus == .needsAuth && other.connect == "Figma" && other.chosenDetail == nil)
        #expect(mcp[0].picking("inconnu") == mcp[0])
        #expect(mcp[1].isMissing && mcp[1].libraryEntry?.id == "figma" && AgentMCPFixes.fixedHere(mcp[1]))
        #expect(AgentMCPFixes.fixedHere(mcp[2]), "un connecteur à connecter : d'ici")
        #expect(!AgentMCPFixes.fixedHere(mcp[3]), "la passerelle : par la page MCP")
        #expect(mcp[4].servers.isEmpty && mcp[4].service == nil && mcp[4].key == "outil-maison")

        // l'état en un mot et une couleur ; un besoin une fois (« figma » et « figma-pro » : un seul Figma) ; prêt si tout
        // est connecté ; « Vérifier » s'il y a un MCP choisi
        let agents = try JSONDecoder().decode(AgentLibrary.self, from: Data("""
        { "agents": [ { "id": "a", "mcp": [ { "name": "figma", "service": "figma", "status": "unknown", "chosen": "figma-pro" } ] },
                      { "id": "b", "mcp": [ { "name": "figma", "service": "figma", "status": "missing" } ] },
                      { "id": "c", "mcp": [ { "name": "figma", "service": "figma", "status": "connected", "chosen": "figma-pro" },
                                            { "name": "figma-pro", "service": "figma", "status": "connected", "chosen": "figma-pro" },
                                            { "name": "Gmail", "service": "gmail", "status": "connected", "chosen": "Gmail" } ] } ] }
        """.utf8)).agents
        #expect(agents.map { AgentMCPState($0.mcp[0], checking: false) } == [.unchecked, .toAdd, .ready])
        #expect(AgentMCPState(agents[0].mcp[0], checking: true) == .checking)
        #expect(agents[2].mcpNeeds.map(\.name) == ["figma", "Gmail"])
        #expect(agents.map(\.mcpReady) == [false, false, true])
        #expect(agents.map(\.canVerifyMCP) == [true, false, true])
        #expect(AgentMCPState.ready.color == Theme.live && AgentMCPState.toConnect.color == Theme.warn)

        // la passerelle : ses espaces (Webflow) et l'actif
        let webflow = try JSONDecoder().decode(AgentMCPServer.self, from: Data("""
        { "name": "webflow-pro", "status": "connected", "connect": false, "space": "p2",
          "spaces": [ { "id": "p1", "label": "Principal" }, { "id": "p2", "label": "Novelo" }, { "label": "sans id" } ] }
        """.utf8))
        #expect(webflow.spaces.map(\.label) == ["Principal", "Novelo"] && webflow.spaceLabel == "Novelo")
    }

    /// Des cases à cocher : leurs choix, un symbole par choix, ceux cochés d'avance (seulement parmi les choix) ; sans
    /// choix, une ligne de texte.
    @Test func decodesChoicesField() throws {
        let fields = try JSONDecoder().decode([AgentField].self, from: Data("""
        [ { "id": "quoi", "label": "Quoi vérifier", "type": "choices", "required": true,
            "options": ["Tout le site", "SEO", "Liens"], "icons": ["checkmark.seal", "magnifyingglass", "link"], "defaults": ["SEO", "Autre"] },
          { "id": "vide", "label": "Vide", "type": "choices", "options": [] },
          { "id": "sans", "label": "Sans symboles", "type": "choices", "options": ["A", "B"] } ]
        """.utf8))
        #expect(fields[0].kind == .choices && fields[0].defaults == ["SEO"] && fields[0].icon(for: "Liens") == "link")
        #expect(fields[1].kind == .text)
        #expect(fields[2].icon(for: "A") == "checkmark.square" && !fields[2].kind.isMultiline)
    }

    /// Dossier proposé : <dossier parent>/<nom du client sans accents ni ponctuation>, 60 caractères au plus.
    @Test func agentFolderNames() throws {
        #expect(AgentSlug.make("Cabinet Martin") == "cabinet-martin")
        #expect(AgentSlug.make("  Œuvre d'Été & Fils !  ") == "oeuvre-d-ete-fils")
        #expect(AgentSlug.make("L'Atelier — Café 2") == "l-atelier-cafe-2")
        #expect(AgentSlug.make("???") == "")
        let long = AgentSlug.make(String(repeating: "abc ", count: 30))
        #expect(long.count <= AgentSlug.maxLength && !long.hasSuffix("-"))

        let agent = try JSONDecoder().decode(AgentInfo.self, from: Data("""
        { "id": "demarrer-projet", "folder": "/Users/alex/Code/",
          "fields": [ { "id": "site", "type": "url" }, { "id": "note", "type": "text" }, { "id": "client", "type": "text", "required": true } ] }
        """.utf8))
        #expect(agent.namingField?.id == "client")
        #expect(agent.suggestedFolder(values: ["client": "Cabinet Martin", "note": "x"]) == "/Users/alex/Code/cabinet-martin")
        #expect(agent.suggestedFolder(values: [:]) == "/Users/alex/Code/")

        // sans champ qui le nomme, le nom du projet se tape directement dans le dossier
        let bare = try JSONDecoder().decode(AgentInfo.self, from: Data(#"{ "id": "Revue SEO" }"#.utf8))
        #expect(bare.suggestedFolder(values: [:]) == "~/Code/")
    }

    @Test func fineFormats() {
        #expect(Fmt.rate(1.2) == "1,2 %/h")
        #expect(Fmt.pctFine(0.034) == "0,03 %")
        #expect(Fmt.pctFine(14.2) == "14 %")
        #expect(Fmt.tokensPerMin(48000) == "48 k tokens/min")
    }

    @Test func rowIdentifiersAreStableAndUnique() {
        let items = ["a", "b", "a", "c", "a"]
        let rows = RowIDs.make(items) { $0 }
        #expect(Set(rows.map(\.id)).count == items.count)
        // Un nouvel élément en tête ne change pas les identifiants des anciens.
        let more = RowIDs.make(["a"] + items) { $0 }
        #expect(Array(more.dropFirst().map(\.id)) == rows.map(\.id))
    }

    @Test func projectNames() {
        #expect(ProjectName.display("atelier") == "Atelier")
        #expect(ProjectName.display("auto-accept") == "Auto-accept")
        #expect(ProjectName.display("back", cwd: "/Users/alex/Code/portail/back") == "Portail · back")
        #expect(ProjectName.display("back", cwd: "/Users/alex/Code/portail-back/back") == "Portail · back")
        #expect(ProjectName.display("front", cwd: "/Users/alex/Code/front") == "Front")
    }

    @Test func fixtureNames() {
        #expect(VigieClient.fixtureName(for: "/api/v2/overview") == "overview.json")
        #expect(VigieClient.fixtureName(for: "/api/v2/conversation/abc") == "conversation-abc.json")
        #expect(VigieClient.fixtureName(for: "/api/v2/mcp") == "mcp.json")
        #expect(VigieClient.fixtureName(for: "/api/v2/agents") == "agents.json")
        #expect(VigieClient.fixtureName(for: "/api/v2/agents/folder?path=%2FUsers%2Falex%2FCode%2Fx") == "agents-folder.json")
        #expect(VigieClient.fixtureName(for: "/api/v2/usage/series?window=600") == "usage-series-600.json")
        #expect(VigieClient.fixtureName(for: "/api/v2/usage/series") == "usage-series-60.json")
    }
}

/// « Coller une commande claude mcp add … ».
struct MCPCommandTests {
    @Test func httpWithHeader() throws {
        let draft = try MCPCommandParser.parse(
            "claude mcp add --transport http figma-pro https://mcp.figma.com/mcp -H \"Authorization: Bearer abc\"").get()
        #expect(draft.transport == .http)
        #expect(draft.name == "figma-pro")
        #expect(draft.url == "https://mcp.figma.com/mcp")
        #expect(draft.headers.first?.key == "Authorization")
        #expect(draft.headers.first?.value == "Bearer abc")
    }

    @Test func stdioWithEnvAndSeparator() throws {
        let draft = try MCPCommandParser.parse(
            "claude mcp add supabase -s project -e SUPABASE_TOKEN=xyz -- npx -y @supabase/mcp-server-supabase --project-ref=abc").get()
        #expect(draft.transport == .stdio)
        #expect(draft.command == "npx")
        #expect(draft.arguments == "-y @supabase/mcp-server-supabase --project-ref=abc")
        #expect(draft.scope == "project")
        #expect(draft.env.first?.value == "xyz")
    }

    @Test func addJSON() throws {
        let draft = try MCPCommandParser.parse(
            "claude mcp add-json obsidian '{\"type\":\"stdio\",\"command\":\"node\",\"args\":[\"server.mjs\"]}'").get()
        #expect(draft.command == "node")
        #expect(draft.arguments == "server.mjs")
    }

    @Test func rejectsOtherCommands() {
        if case .success = MCPCommandParser.parse("npm install x") {
            Issue.record("une commande npm ne doit pas être acceptée")
        }
    }

    @Test func maskedValuesBlockSaving() {
        var draft = MCPDraft.from(name: "artlist", type: "http", target: "https://mcp.artlist.io/mcp?key=••••")
        #expect(draft.containsMaskedValue)
        draft.url = "https://mcp.artlist.io/mcp?key=nouvelle"
        #expect(!draft.containsMaskedValue)
    }
}
