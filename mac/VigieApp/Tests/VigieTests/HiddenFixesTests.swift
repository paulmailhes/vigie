import Foundation
import Testing
@testable import Vigie

/// « À régler » de la page MCP : la croix « Masquer », retenue sur l'identité de la chose à régler.
@MainActor
struct HiddenFixesTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private static var previewFolder: URL {
        URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Preview", directoryHint: .isDirectory)
    }

    private func accounts() throws -> [Account] {
        try JSONDecoder().decode([Account].self, from: Data("""
        [ { "id": "travail1", "label": "Travail 1", "connected": true },
          { "id": "perso", "label": "Perso", "connected": true } ]
        """.utf8))
    }

    /// figma-pro (Travail 1, Perso) et supabase (projet Portail), dans l'état donné compte par compte.
    private func fixes(figma: [String: String], supabase: [String: String]) throws -> [MCPFix] {
        func health(_ states: [String: String]) -> String {
            states.sorted { $0.key < $1.key }.map { #"{ "accountId": "\#($0.key)", "status": "\#($0.value)" }"# }
                .joined(separator: ", ")
        }
        let mcp = try JSONDecoder().decode(MCPState.self, from: Data("""
        { "user": [ { "name": "figma-pro", "service": "figma", "accounts": ["travail1", "perso"],
                      "health": [ \(health(figma)) ] } ],
          "projects": [ { "path": "/Users/alex/Code/portail", "name": "portail",
                          "servers": [ { "name": "supabase", "health": [ \(health(supabase)) ] } ] } ],
          "local": [], "connectors": [] }
        """.utf8))
        return MCPFix.all(in: mcp, accounts: try accounts())
    }

    @Test func aHiddenLineLeavesAndIsNoLongerCounted() throws {
        let list = try fixes(figma: ["travail1": "needs-auth", "perso": "connected"],
                             supabase: ["travail1": "pending-approval"])
        #expect(list.map(\.text) == ["À connecter sur Travail 1", "À approuver dans Claude Code, sur Travail 1"])
        var hidden = HiddenFixes()
        #expect(hidden.visible(list).count == 2)
        let hid = hidden.hide(list[0].id)
        #expect(hid)
        let hidAgain = hidden.hide(list[0].id)
        #expect(!hidAgain, "déjà masquée : rien ne change")
        // « À régler 1 », « 1 masqué · Réafficher »
        #expect(hidden.visible(list).map(\.name) == ["supabase"])
        #expect(hidden.hiddenCount(in: list) == 1)
        // tout masqué : plus rien à l'écran, la section disparaît
        hidden.hide(list[1].id)
        #expect(hidden.visible(list).isEmpty)
        #expect(hidden.hiddenCount(in: list) == 2)
        // « Réafficher » : tout revient
        let shown = hidden.showAll()
        #expect(shown)
        #expect(hidden.visible(list).count == 2)
        let shownAgain = hidden.showAll()
        #expect(!shownAgain)
    }

    @Test func aLineComesBackWhenItsStateChanges() throws {
        let before = try fixes(figma: ["travail1": "needs-auth", "perso": "connected"],
                               supabase: ["travail1": "pending-approval"])
        var hidden = HiddenFixes()
        for fix in before { hidden.hide(fix.id) }
        #expect(hidden.visible(before).isEmpty)
        // figma-pro passe en échec sur Travail 1 (une autre sorte) ; supabase attend aussi sur Perso (d'autres comptes)
        let after = try fixes(figma: ["travail1": "failed", "perso": "connected"],
                              supabase: ["travail1": "pending-approval", "perso": "pending-approval"])
        #expect(hidden.visible(after).map(\.text) == ["En échec sur Travail 1",
                                                      "À approuver dans Claude Code, sur Travail 1 et Perso"])
        #expect(hidden.hiddenCount(in: after) == 0)
        // le même état sur un autre compte : une autre ligne aussi
        let otherAccount = try fixes(figma: ["travail1": "connected", "perso": "needs-auth"], supabase: [:])
        #expect(hidden.visible(otherAccount).map(\.text) == ["À connecter sur Perso"])
    }

    /// webflow (par Vigie) dans l'état donné : `profiles` en JSON, l'espace actif, connecté ou non.
    private func gatewayFixes(profiles: String, active: String? = nil, connected: Bool = false) throws -> [MCPFix] {
        let activeField = active.map { #""active": "\#($0)", "# } ?? ""
        let mcp = try JSONDecoder().decode(MCPState.self, from: Data("""
        { "user": [ { "name": "webflow", "service": "webflow", "health": [] } ],
          "projects": [], "local": [], "connectors": [],
          "gateway": { "webflow": { \(activeField)"connected": \(connected), "profiles": \(profiles) } } }
        """.utf8))
        return MCPFix.all(in: mcp, accounts: try accounts())
    }

    @Test func aGatewayLineComesBackWhenTheServiceCutsAccess() throws {
        // pas encore connecté : masqué d'une croix
        let new = try gatewayFixes(profiles: "[]")
        #expect(new.map(\.text) == ["Pas encore connecté : une seule connexion pour tous tes comptes"])
        var hidden = HiddenFixes()
        hidden.hide(new[0].id)
        #expect(hidden.visible(new).isEmpty)
        // connecté à l'espace « Studio », puis le service coupe l'accès : une autre ligne, elle revient
        let cut = try gatewayFixes(profiles: #"[ { "id": "p1", "label": "Studio", "error": "révoqué" } ]"#,
                                   active: "p1", connected: true)
        #expect(cut.map(\.text) == ["Le service a coupé l'accès à l'espace « Studio »"])
        #expect(cut[0].id != new[0].id)
        #expect(hidden.visible(cut).count == 1)
        #expect(hidden.hiddenCount(in: cut) == 0)
        // masquée à son tour : elle reste masquée tant que c'est le même espace coupé
        hidden.hide(cut[0].id)
        let same = try gatewayFixes(profiles: #"[ { "id": "p1", "label": "Studio", "error": "révoqué" } ]"#,
                                    active: "p1", connected: true)
        #expect(hidden.visible(same).isEmpty)
        #expect(hidden.hiddenCount(in: same) == 1)
        // un autre espace coupé : il revient
        let otherSpace = try gatewayFixes(profiles: #"[ { "id": "p1", "label": "Studio" }, { "id": "p2", "label": "Client B", "error": "révoqué" } ]"#,
                                          active: "p2", connected: true)
        #expect(hidden.visible(otherSpace).map(\.text) == ["Le service a coupé l'accès à l'espace « Client B »"])
        // les autres sortes gardent leur identité d'avant (masquages déjà retenus)
        let figma = try fixes(figma: ["travail1": "needs-auth", "perso": "connected"], supabase: [:])
        #expect(figma.map(\.id) == ["connect|figma-pro||travail1"])
    }

    @Test func linesThatNoLongerMatchAreForgottenAfterADay() throws {
        let list = try fixes(figma: ["travail1": "needs-auth", "perso": "connected"],
                             supabase: ["travail1": "pending-approval"])
        let figma = list[0].id, supabase = list[1].id
        var hidden = HiddenFixes()
        hidden.hide(figma)
        hidden.hide(supabase)
        // tout est encore là : rien ne change (rien à réécrire à chaque relecture)
        let unchanged = hidden.prune(current: Set(list.map(\.id)), at: now)
        #expect(!unchanged)
        // figma-pro réglé : il ne correspond plus à rien, mais un état passager ne l'efface pas tout de suite
        let gone = hidden.prune(current: [supabase], at: now)
        #expect(gone)
        #expect(hidden.contains(figma))
        let stillGone = hidden.prune(current: [supabase], at: now.addingTimeInterval(23 * 3600))
        #expect(!stillGone)
        #expect(hidden.contains(figma))
        // revenu entre-temps : toujours masqué, et le compte à rebours repart de zéro
        let back = hidden.prune(current: [figma, supabase], at: now.addingTimeInterval(23 * 3600))
        #expect(back)
        #expect(hidden.missingSince.isEmpty)
        hidden.prune(current: [supabase], at: now.addingTimeInterval(24 * 3600))
        #expect(hidden.contains(figma))
        // 24 h sans correspondance : oublié
        let forgotten = hidden.prune(current: [supabase], at: now.addingTimeInterval(48 * 3600))
        #expect(forgotten)
        #expect(!hidden.contains(figma))
        #expect(hidden.ids == [supabase])
        #expect(hidden.missingSince.isEmpty)
    }

    @Test func hiddenLinesAreKeptAcrossLaunches() throws {
        let suite = "vigie.essais.masques.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var hidden = HiddenFixes()
        hidden.hide("connect|figma-pro||travail1")
        hidden.hide("approve|supabase|/Users/alex/Code/portail|travail1")
        hidden.prune(current: ["connect|figma-pro||travail1"], at: now)
        hidden.save(to: defaults)
        #expect(HiddenFixes.load(from: defaults) == hidden)
        // tout réaffiché : plus rien de gardé
        hidden.showAll()
        hidden.save(to: defaults)
        #expect(defaults.data(forKey: "mcp.hiddenFixes") == nil)
        #expect(HiddenFixes.load(from: defaults) == HiddenFixes())
    }

    @Test func theCrossAppliesAtOnceAndKeepsNothingInDemo() async throws {
        let store = VigieStore(client: VigieClient(source: .fixtures(Self.previewFolder)))
        let fix = MCPFix(kind: .verify, name: "linear", service: nil, origin: Theme.title(for: .mac))
        store.hideFix(fix)
        #expect(store.hiddenFixes.contains(fix.id))
        #expect(HiddenFixes.load().ids.isEmpty, "en démonstration, rien n'est écrit")
        store.showHiddenFixes()
        #expect(store.hiddenFixes == HiddenFixes())
    }
}
