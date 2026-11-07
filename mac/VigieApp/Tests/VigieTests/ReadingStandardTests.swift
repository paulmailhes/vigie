import Foundation
import Testing
@testable import Vigie

/// Le standard de lecture : noms lisibles, unités, tiret unique, et les trois listes (À décider · À regarder · À relire).
@MainActor
struct ReadingStandardTests {
    @Test func agentTitlesNeverShowATechnicalID() {
        let steps = [PlanStep(id: "C7", text: "Poser les 37 doubles pages", status: "doing", group: nil)]
        // nom lisible : tel quel
        #expect(Fmt.agentTitle(name: "L2.24 Icônes de fin de partie", title: "faire:L2.24", id: "a1") == "L2.24 Icônes de fin de partie")
        // identifiant technique : l'étape du plan, sinon « Agent C7 »
        #expect(Fmt.agentTitle(name: nil, title: "faire:C7", id: "a1", planSteps: steps) == "C7 Poser les 37 doubles pages")
        #expect(Fmt.agentTitle(name: nil, title: "faire:c7", id: "a1", planSteps: steps) == "C7 Poser les 37 doubles pages")
        #expect(Fmt.agentTitle(name: nil, title: "faire:C8", id: "a1", planSteps: steps) == "Agent C8")
        #expect(Fmt.agentTitle(name: "explore:L2.24", title: nil, id: nil) == "Agent L2.24")
        // une description lisible passe avant le repli
        #expect(Fmt.agentTitle(name: nil, title: "Relit la charte", id: "faire:C7") == "Relit la charte")
        // un nom en tirets devient lisible, un identifiant opaque ne s'affiche jamais
        #expect(Fmt.agentTitle(name: nil, title: "livre-lot-6", id: "a1b2c3") == "Livre lot 6")
        #expect(Fmt.agentTitle(name: nil, title: nil, id: "a1b2c3") == "Agent")
        #expect(Fmt.agentTitle(name: "  ", title: "", id: nil) == "Agent")
    }

    @Test func workflowTitlesAreReadable() {
        #expect(Fmt.workflowTitle("partie-c-charte-ecrans") == "Partie C charte ecrans")
        #expect(Fmt.workflowTitle("lot_6") == "Lot 6")
        #expect(Fmt.workflowTitle("Refonte du portail") == "Refonte du portail")
        #expect(Fmt.workflowTitle("Auto-accept") == "Auto accept")
        #expect(Fmt.workflowTitle("charte") == "charte")
    }

    @Test func unitsAndMissingValues() {
        #expect(Fmt.count(0, "appel") == "0 appel")
        #expect(Fmt.count(1, "appel") == "1 appel")
        #expect(Fmt.count(3657, "appel") == Fmt.int(3657) + " appels")
        #expect(Fmt.count(2, "travail", "travaux") == "2 travaux")
        #expect(Fmt.pct(nil) == "—")
        #expect(Fmt.memory(mb: nil) == "—")
        #expect(Fmt.none == "—")
    }

    @Test func deadlines() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(Fmt.remaining(until: now.addingTimeInterval(8 * 60), now: now) == "dans 8 min")
        #expect(Fmt.remaining(until: now.addingTimeInterval(7 * 60 + 10), now: now) == "dans 8 min")
        #expect(Fmt.remaining(until: now.addingTimeInterval(40), now: now) == "dans 40 s")
        #expect(Fmt.remaining(until: now.addingTimeInterval(2 * 3600 + 5), now: now) == "dans 2 h")
        #expect(Fmt.remaining(until: now.addingTimeInterval(-5), now: now) == "maintenant")
        #expect(Fmt.remaining(until: nil, now: now) == "")
    }

    @Test func freshnessSaysUpdated() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let text = Freshness.text(date: now.addingTimeInterval(-12 * 60), now: now)
        #expect(text.hasPrefix("mis à jour il y a 12 min · "))
    }

    @Test func infoLineJoinsWhatIsThere() {
        #expect(InfoLine.text(["Atelier", nil, "", "git push", "01:17"]) == "Atelier · git push · 01:17")
        #expect(InfoLine.text([nil, ""]) == "")
    }

    @Test func statusLabelsFollowTheVocabulary() {
        #expect(Theme.label(for: .blocked) == "À autoriser")
        #expect(Theme.decision(.blocked).label == "Refusée d'office")
        #expect(Theme.decision(.waiting).label == "T'attend")
    }

    @Test func threeListsSplitWhatToDo() throws {
        let json = """
        [ { "id": "g1", "kind": "blocked", "state": "waiting", "pendingId": "p1", "conversationId": "c1",
            "expiresAt": "2026-11-07T10:20:00Z", "ts": "2026-11-07T10:00:00Z" },
          { "id": "g2", "kind": "blocked", "state": "waiting", "pendingId": "p2", "conversationId": "c2",
            "expiresAt": "2026-11-07T10:12:00Z", "ts": "2026-11-07T09:58:00Z" },
          { "id": "w1", "kind": "waiting", "conversationId": "c1", "ts": "2026-11-07T10:05:00Z" },
          { "id": "w2", "kind": "waiting", "conversationId": "c2", "ts": "2026-11-07T09:00:00Z" },
          { "id": "v1", "kind": "blocked", "state": "awaiting", "approvalId": "a1", "conversationId": "c3",
            "ts": "2026-11-07T08:00:00Z" },
          { "id": "b1", "kind": "blocked", "state": "blocked", "reason": "delai", "conversationId": "c1",
            "ts": "2026-11-07T07:00:00Z" },
          { "id": "b2", "kind": "blocked", "state": "blocked", "reason": "echec", "needsPassword": true,
            "conversationId": "c2", "ts": "2026-11-07T06:00:00Z" },
          { "id": "l1", "kind": "limit", "conversationId": "c1", "ts": "2026-11-07T05:00:00Z" },
          { "id": "q1", "kind": "question", "conversationId": "c1", "ts": "2026-11-07T04:00:00Z" },
          { "id": "s:c2:1", "kind": "notice", "conversationId": "c2", "ts": "2026-11-07T03:00:00Z" },
          { "id": "cx:perso:dead", "kind": "notice", "accountId": "perso", "ts": "2026-11-07T02:00:00Z" } ]
        """
        let items = try JSONDecoder().decode([ReviewItem].self, from: Data(json.utf8))
        let decisions = items.filter(VigieStore.isDecision)
        // l'échéance la plus proche d'abord, puis la plus récente
        #expect(VigieStore.byDeadline(decisions).map(\.id) == ["g2", "g1", "w1", "w2", "v1"])
        // un avis du moteur (compte changé, compte à reconnecter) n'est pas une décision : « À regarder »
        #expect(items.filter(VigieStore.isLook).map(\.id) == ["b1", "b2", "l1", "s:c2:1", "cx:perso:dead"])
        #expect(items.filter { !VigieStore.isDecision($0) && !VigieStore.isLook($0) }.map(\.id) == ["q1"])
        // « Retirer » seulement pour ce que le moteur sait retirer : un compte à reconnecter reste
        #expect(items.filter(VigieStore.canDismiss).map(\.id) == ["b1", "b2", "l1", "s:c2:1"])
    }

    @Test func percentAndUnitsNeverBreak() {
        #expect(Fmt.pct(14) == "14\u{00A0}%")
        #expect(Fmt.pct(2.4) == "2,4\u{00A0}%")
        #expect(ConversationListRow.weekShare(2.4) == "2\u{00A0}% de la semaine")
        #expect(ConversationListRow.weekShare(0.4) == "< 1\u{00A0}% de la semaine")
        #expect(ConversationListRow.weekShare(0) == nil)
    }

    @Test func aDecisionChipSaysTheSameWordEverywhere() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let json = """
        [ { "id": "v1", "kind": "blocked", "state": "awaiting", "approvalId": "a1", "ts": "2026-11-07T08:00:00Z" },
          { "id": "g1", "kind": "blocked", "state": "waiting", "pendingId": "p1", "expiresAt": "\(now.addingTimeInterval(480).formatted(.iso8601))" },
          { "id": "g2", "kind": "blocked", "state": "waiting", "pendingId": "p2", "expiresAt": "\(now.addingTimeInterval(-5).formatted(.iso8601))" },
          { "id": "c1", "kind": "waiting", "conversationId": "c1" } ]
        """
        let items = try JSONDecoder().decode([ReviewItem].self, from: Data(json.utf8))
        // « À autoriser » dans la barre des menus comme dans la fenêtre ; le délai passé : « Refusée d'office »
        #expect(DecisionDeadline.text(items[0], now: now)?.text == Theme.label(for: .blocked))
        #expect(DecisionDeadline.text(items[1], now: now)?.text == "Refusée dans 8 min")
        #expect(DecisionDeadline.text(items[2], now: now)?.text == "Refusée d'office")
        #expect(DecisionDeadline.text(items[3], now: now) == nil)
    }

    @Test func aProgramMCPShowsItsCommandWithoutPaths() {
        #expect(MCPHelp.shortTarget("node /Users/alex/Code/notes-mcp/server.mjs") == "node server.mjs")
        #expect(MCPHelp.shortTarget("/Applications/Anarlog.app/Contents/MacOS/anarlog-mcp --stdio") == "anarlog-mcp --stdio")
        #expect(MCPHelp.shortTarget("https://mcp.figma.com/mcp") == "mcp.figma.com")
        #expect(MCPHelp.origin(type: "stdio", target: "python3 ~/Code/x/server.py") == "Programme · python3 server.py")
        // la commande entière au survol, seulement quand elle a été raccourcie
        #expect(MCPHelp.fullCommand(type: "stdio", target: "node /Users/alex/Code/notes-mcp/server.mjs") == "node /Users/alex/Code/notes-mcp/server.mjs")
        #expect(MCPHelp.fullCommand(type: "stdio", target: "npx notion-mcp") == nil)
        #expect(MCPHelp.fullCommand(type: "http", target: "https://mcp.figma.com/mcp") == nil)
    }

    @Test func noTestsIsNotAWarning() throws {
        let none = try JSONDecoder().decode(RequestChecks.self, from: Data(#"{ "verdict": "noTests", "label": "aucun test lancé" }"#.utf8))
        let verdict = try #require(FinishedReportRow.verdict(none))
        // gris et sans icône, comme dans la page de la conversation : rien de prouvé, pas un défaut
        #expect(verdict.color == nil && verdict.symbol == nil)
    }

    @Test func compactionSaysHowOnlyWhenItIsKnown() throws {
        func how(_ json: String) throws -> String? {
            let c = try JSONDecoder().decode(ContextCompactions.self, from: Data(json.utf8))
            return StateTile.compactedHow(c, count: c.count ?? 0)
        }
        #expect(try how(#"{ "count": 2, "auto": 2, "manual": 0 }"#) == "automatiquement, chaque fois que le contexte débordait")
        #expect(try how(#"{ "count": 1, "auto": 0, "manual": 1 }"#) == "à ta demande (/compact)")
        #expect(try how(#"{ "count": 3, "auto": 1, "manual": 1 }"#) == "dont 1 automatiquement")
        // un résumé vu seulement par son message, ou un moteur plus ancien : on ne sait pas, on ne dit pas « /compact »
        #expect(try how(#"{ "count": 1, "auto": 0, "manual": 0 }"#) == nil)
        #expect(try how(#"{ "count": 1, "auto": 0 }"#) == nil)
    }

    @Test func theJournalSkipsReadsInBothWordings() throws {
        let json = """
        { "activity": [ { "ts": "2026-11-07T10:00:00Z", "kind": "file", "title": "Lire a.ts" },
                        { "ts": "2026-11-07T10:00:10Z", "kind": "file", "title": "Lit b.ts" },
                        { "ts": "2026-11-07T10:00:20Z", "kind": "other", "title": "Chercher « jauge »" },
                        { "ts": "2026-11-07T10:00:30Z", "kind": "file", "title": "Modifier c.ts" },
                        { "ts": "2026-11-07T10:00:40Z", "kind": "other", "title": "Chercher sur le web « vitest »" } ] }
        """
        let detail = try JSONDecoder().decode(ConversationDetail.self, from: Data(json.utf8))
        // les lectures et recherches dans le code ne s'affichent pas (titres d'aujourd'hui ou d'un moteur plus ancien)
        #expect(ConversationDetailModel(detail).feed.map(\.value.title) == ["Chercher sur le web « vitest »", "Modifier c.ts"])
    }

    /// Un Int dans un libellé de bouton est groupé selon la langue (« localhost:5 173 ») : toujours `String(port)`.
    @Test func portsAreNeverGroupedInALabel() throws {
        let sources = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Sources", directoryHint: .isDirectory)
        let files = try #require(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
        var offenders: [String] = []
        for case let url as URL in files where url.pathExtension == "swift" {
            let text = try String(contentsOf: url, encoding: .utf8)
            for line in text.split(separator: "\n") where line.contains("Button(\"") && line.contains("localhost:\\(") {
                if line.contains("localhost:\\(port)") { offenders.append("\(url.lastPathComponent): \(line)") }
            }
        }
        #expect(offenders.isEmpty, "\(offenders)")
    }
}
