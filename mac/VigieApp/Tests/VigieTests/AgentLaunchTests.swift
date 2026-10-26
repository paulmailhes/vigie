import Foundation
import Testing
@testable import Vigie

/// Le dossier du projet, vérifié dans la feuille comme le moteur le fera (lib/agents.mjs, projectFolder), sur un faux
/// dossier perso dans le dossier temporaire : rien n'est écrit ailleurs.
struct AgentFolderRuleTests {
    /// Un faux dossier perso, avec ses dossiers réservés et un dépôt ; effacé à la fin de l'essai.
    private final class FakeHome {
        let path: String
        let outside: String

        /// `without` : des dossiers de départ à ne pas créer (« .ssh » pour qui n'a pas de clés).
        init(without: Set<String> = []) throws {
            let base = FileManager.default.temporaryDirectory.path(percentEncoded: false)
            let root = (base as NSString).appendingPathComponent("vigie-essai-\(UUID().uuidString)")
            path = (root as NSString).appendingPathComponent("maison")
            outside = (root as NSString).appendingPathComponent("disque-externe")
            for dir in ["Code/depot", ".claude", ".ssh", ".vigie/data", "Library/LaunchAgents"] where !without.contains(dir) {
                try FileManager.default.createDirectory(atPath: path + "/" + dir, withIntermediateDirectories: true)
            }
            try FileManager.default.createDirectory(atPath: outside, withIntermediateDirectories: true)
        }

        /// Le disque du Mac ne distingue pas les majuscules (le cas par défaut) : .CLAUDE mène à .claude.
        var caseInsensitive: Bool { FileManager.default.fileExists(atPath: path + "/.CLAUDE") }

        /// Son chemin réel (« /private/var/folders/… » pour le dossier temporaire).
        var real: String {
            guard let resolved = realpath(path, nil) else { return path }
            defer { free(resolved) }
            return String(cString: resolved)
        }

        func link(_ name: String, to target: String) throws {
            try FileManager.default.createSymbolicLink(atPath: path + "/" + name, withDestinationPath: target)
        }

        func issue(_ folder: String, parent: String = "~/Code") -> String? {
            AgentFolderRule.issue(folder, parent: parent, home: path)
        }

        deinit { try? FileManager.default.removeItem(atPath: (path as NSString).deletingLastPathComponent) }
    }

    private static let outsideHome = "Dossier refusé : il doit être dans ton dossier perso."
    private static let homeItself = "Dossier refusé : choisis un dossier dans ton dossier perso, pas le dossier perso lui-même."
    private static let unreadable = "Dossier refusé : chemin trop long ou illisible. Choisis un autre dossier avec « Choisir… »."
    private static func reserved(_ name: String) -> String {
        "Dossier refusé : ~/\(name) est réservé (Vigie, réglages du Mac, Claude Code ou clés), choisis un autre dossier."
    }

    @Test func expandsLikeTheEngine() {
        let home = "/Users/alex"
        #expect(AgentFolderRule.expanded("~/Code/x/", home: home) == "/Users/alex/Code/x")
        #expect(AgentFolderRule.expanded(" ~ ", home: home) == "/Users/alex")
        #expect(AgentFolderRule.expanded("~/Code/./a/../b//c", home: home) == "/Users/alex/Code/b/c")
        #expect(AgentFolderRule.expanded("/Users/alex/Code/../.ssh", home: home) == "/Users/alex/.ssh")
        #expect(AgentFolderRule.expanded("Code/x", home: home) == "Code/x")
    }

    @Test func acceptsAProjectFolderInHome() throws {
        let home = try FakeHome()
        #expect(home.issue("~/Code/cabinet-martin") == nil)
        #expect(home.issue("~/Code/cabinet-martin/") == nil)
        #expect(home.issue(home.path + "/Code/depot/nouveau/sous-dossier") == nil)
        #expect(home.issue("~/Documents/Clients/martin") == nil)
        // ~/Code relié à un disque externe : accepté, comme par le moteur
        try home.link("Code/externe", to: home.outside)
        #expect(home.issue("~/Code/externe/martin") == nil)
    }

    @Test func refusesEmptyRelativeAndUnreadable() throws {
        let home = try FakeHome()
        #expect(home.issue("  ") == "Indique le dossier du projet.")
        #expect(home.issue("Code/martin") == "Indique un chemin complet, par exemple ~/Code/cabinet-martin.")
        #expect(home.issue("~/Code/mar\ttin") == Self.unreadable)
        #expect(home.issue("~/" + String(repeating: "a", count: 1100)) == Self.unreadable)
    }

    @Test func refusesOutsideHome() throws {
        let home = try FakeHome()
        #expect(home.issue("/Volumes/Data/Clients/martin") == Self.outsideHome)
        #expect(home.issue("/") == Self.outsideHome)
        #expect(home.issue(home.outside + "/martin") == Self.outsideHome)
        #expect(home.issue("~/../voisin/martin") == Self.outsideHome)
        // le dossier proposé par l'AGENT.md hors du dossier perso : refusé dès qu'un nom est saisi
        #expect(home.issue("/Volumes/Data/Clients/martin", parent: "/Volumes/Data/Clients") == Self.outsideHome)
    }

    @Test func refusesHomeAndParentThemselves() throws {
        let home = try FakeHome()
        #expect(home.issue("~") == "Choisis un dossier rien que pour ce projet, pas ~ lui-même.")
        #expect(home.issue("~/") == "Choisis un dossier rien que pour ce projet, pas ~ lui-même.")
        #expect(home.issue("~/Code/") == "Choisis un dossier rien que pour ce projet, pas ~/Code lui-même.")
        #expect(home.issue(home.path + "/Code") == "Choisis un dossier rien que pour ce projet, pas ~/Code lui-même.")
    }

    @Test func refusesReservedFolders() throws {
        let home = try FakeHome()
        #expect(home.issue("~/.vigie") == Self.reserved(".vigie"))
        #expect(home.issue("~/.vigie/data/x") == Self.reserved(".vigie"))
        #expect(home.issue("~/Library/Projets") == Self.reserved("Library"))
        #expect(home.issue("~/.claude/x") == Self.reserved(".claude"))
        #expect(home.issue("~/.claude-comptes/travail") == Self.reserved(".claude-comptes"))
        #expect(home.issue("~/.ssh") == Self.reserved(".ssh"))
        // pas encore créé : refusé quand même
        #expect(home.issue("~/.codex/p") == Self.reserved(".codex"))
        // un nom qui commence pareil n'est pas réservé
        #expect(home.issue("~/.claude-notes/x") == nil)
        #expect(home.issue("~/Library2/x") == nil)
    }

    /// Le disque ne distingue pas les majuscules : ~/.SSH est ~/.ssh.
    @Test func comparesWithoutCase() throws {
        let home = try FakeHome()
        #expect(home.issue("~/.VIGIE/data") == Self.reserved(".vigie"))
        #expect(home.issue("~/LIBRARY/LaunchAgents") == Self.reserved("Library"))
        #expect(home.issue("~/library/Application Support/x") == Self.reserved("Library"))
        #expect(home.issue("~/.SSH") == Self.reserved(".ssh"))
        #expect(home.issue("~/.Claude/projects") == Self.reserved(".claude"))
        #expect(home.issue("~/.CODEX/x") == Self.reserved(".codex"))
        #expect(home.issue("~/.Claude-Comptes") == Self.reserved(".claude-comptes"))
        // le dossier perso écrit avec d'autres majuscules reste le dossier perso
        #expect(home.issue(home.path.uppercased()) == "Choisis un dossier rien que pour ce projet, pas ~ lui-même.")
        #expect(home.issue(home.path.uppercased() + "/Code/martin") == nil)
        #expect(home.issue(home.path.uppercased() + "/.Ssh/x") == Self.reserved(".ssh"))
        // et le dossier parent proposé aussi
        #expect(home.issue("~/CODE") == "Choisis un dossier rien que pour ce projet, pas ~/CODE lui-même.")
        // accents écrits de deux façons (é composé ou e + accent) : le même dossier
        #expect(home.issue("~/Cod\u{0065}\u{0301}", parent: "~/Cod\u{00E9}")
            == "Choisis un dossier rien que pour ce projet, pas ~/Cod\u{0065}\u{0301} lui-même.")
    }

    /// Le disque plie les majuscules comme Unicode, pas seulement comme les minuscules : « ſ » (s long) y est « s ».
    /// Un dossier réservé pas encore créé (pas de clés SSH) n'a pas de chemin réel pour rattraper l'écart.
    @Test func foldsCaseLikeTheDisk() throws {
        let home = try FakeHome(without: [".ssh"])
        #expect(home.issue("~/.SSH/x") == Self.reserved(".ssh"))
        #expect(home.issue("~/.\u{017F}\u{017F}h/x") == Self.reserved(".ssh"))
        #expect(home.issue("~/.claude-compte\u{017F}/x") == Self.reserved(".claude-comptes"))
        // ce qui doit passer passe encore
        #expect(home.issue("~/Code/Stra\u{00DF}e") == nil)
        #expect(home.issue("~/.claude-notes/x") == nil)
        #expect(home.issue("~/Library2/x") == nil)
    }

    /// Un lien d'un dépôt (partagé, cloné) vers un dossier réservé ou vers le dossier perso : son chemin réel compte.
    @Test func followsSymbolicLinks() throws {
        let home = try FakeHome()
        try home.link("Code/depot/cl", to: "../../.claude")
        try home.link("Code/depot/cles", to: home.path + "/.ssh")
        try home.link("Code/depot/maison", to: "../..")
        #expect(home.issue("~/Code/depot/cl") == Self.reserved(".claude"))
        #expect(home.issue("~/Code/depot/cl/projet") == Self.reserved(".claude"))
        #expect(home.issue("~/Code/depot/cles/x") == Self.reserved(".ssh"))
        #expect(home.issue("~/Code/depot/maison") == Self.homeItself)
        #expect(home.issue("~/Code/depot/maison/Library/x") == Self.reserved("Library"))

        if home.caseInsensitive {
            try home.link("Code/depot/cl2", to: "../../.CLAUDE")
            try home.link("Code/depot/chez-moi", to: home.path.uppercased())
            #expect(home.issue("~/Code/depot/cl2/x") == Self.reserved(".claude"))
            #expect(home.issue("~/Code/depot/chez-moi") == Self.homeItself)
            #expect(home.issue("~/Code/depot/chez-moi/.VIGIE") == Self.reserved(".vigie"))
        }
    }

    /// /System/Volumes/Data<dossier perso> est le dossier perso (le volume des données du Mac), mais son chemin réel
    /// garde ce début : c'est le dossier lui-même qui compte, pas son chemin.
    @Test func seesTheSameFolderThroughTheDataVolume() throws {
        let home = try FakeHome()
        let data = "/System/Volumes/Data" + home.real
        // ce volume existe sur tout Mac récent : l'essai ne doit pas passer à vide
        try #require(FileManager.default.fileExists(atPath: data + "/.ssh"))
        try home.link("Code/depot/fh", to: data)
        try home.link("Code/depot/fl", to: data + "/.ssh")
        #expect(home.issue("~/Code/depot/fh") == Self.homeItself)
        #expect(home.issue("~/Code/depot/fh/.ssh/x") == Self.reserved(".ssh"))
        #expect(home.issue("~/Code/depot/fh/Library/LaunchAgents") == Self.reserved("Library"))
        #expect(home.issue("~/Code/depot/fl/x") == Self.reserved(".ssh"))
        // pas encore créé, ou écrit autrement
        #expect(home.issue("~/Code/depot/fh/.codex/p") == Self.reserved(".codex"))
        #expect(home.issue("~/Code/depot/fh/.\u{017F}sh") == Self.reserved(".ssh"))
        // un vrai projet par ce chemin reste accepté
        #expect(home.issue("~/Code/depot/fh/Code/martin") == nil)
    }
}

/// « Lancer dans VS Code » : VS Code vérifié avant le moteur, refus rendu à la feuille, ouverture vérifiée.
@MainActor
struct AgentLaunchTests {
    /// La réponse du moteur à un lancement réussi (lib/agents.mjs, launch).
    private static let launched = """
    { "ok": true, "folder": "/Users/alex/Code/cabinet-martin",
      "briefFile": "/Users/alex/Code/cabinet-martin/.vigie/agent-demarrer-projet.md",
      "openUrl": "vscode://anthropic.claude-code/open?prompt=Lance%20l'agent",
      "prompt": "Lance l'agent « Démarrer un projet » : lis le fichier /Users/alex/Code/cabinet-martin/.vigie/agent-demarrer-projet.md et suis ses consignes, dans le dossier /Users/alex/Code/cabinet-martin.",
      "message": "Dossier prêt : VS Code s'ouvre, envoie le message préparé pour lancer l'agent." }
    """

    private static func result(_ json: String = launched) throws -> WriteResult {
        try JSONDecoder().decode(WriteResult.self, from: Data(json.utf8))
    }

    @Test func readsThePreparedMessage() throws {
        let result = try Self.result()
        #expect(result.prompt?.hasPrefix("Lance l'agent « Démarrer un projet »") == true)
        #expect(result.folder == "/Users/alex/Code/cabinet-martin")
    }

    /// Sans VS Code, le moteur n'est pas appelé : rien n'est créé, la feuille dit pourquoi.
    @Test func withoutVSCodeNothingIsCreated() async throws {
        let result = try Self.result()
        var prepared = 0
        var opened: [String] = []
        let outcome = await AgentLaunch.run(hasVSCode: false, folder: "/Users/alex/Code/cabinet-martin",
                                            prepare: { prepared += 1; return .success(result) },
                                            openFolder: { opened.append($0); return true })
        #expect(outcome == .refused(AgentLaunch.noVSCodeMessage))
        #expect(prepared == 0)
        #expect(opened.isEmpty)
    }

    /// Le refus du moteur revient à la feuille (qui le montre et reste ouverte), pas au toast de la fenêtre.
    @Test func engineRefusalGoesBackToTheSheet() async {
        var opened = 0
        let refusal = "Dossier refusé : il doit être dans ton dossier perso."
        let outcome = await AgentLaunch.run(hasVSCode: true, folder: "/Volumes/Data/martin",
                                            prepare: { .failure(.refused(refusal)) },
                                            openFolder: { _ in opened += 1; return true })
        #expect(outcome == .refused(refusal))
        #expect(opened == 0)

        let down = await AgentLaunch.run(hasVSCode: true, folder: "/Users/alex/Code/x",
                                         prepare: { .failure(.unreachable) }, openFolder: { _ in true })
        #expect(down == .refused(ClientError.unreachable.message))
    }

    /// VS Code ne s'ouvre pas : la feuille le dit et propose de copier le message préparé par le moteur.
    @Test func vsCodeThatDoesNotOpenKeepsTheMessage() async throws {
        let result = try Self.result()
        let prompt = try #require(result.prompt)
        var opened: [String] = []
        let outcome = await AgentLaunch.run(hasVSCode: true, folder: "~/Code/cabinet-martin",
                                            prepare: { .success(result) },
                                            openFolder: { opened.append($0); return false })
        #expect(outcome == .notOpened(prompt: prompt))
        // le dossier que le moteur a préparé, pas celui de la feuille
        #expect(opened == ["/Users/alex/Code/cabinet-martin"])

        // moteur sans « prompt » : un message de secours qui nomme la consigne
        let bare = try Self.result(#"{ "ok": true, "folder": "/Users/alex/Code/x", "briefFile": "/Users/alex/Code/x/.vigie/agent-a.md" }"#)
        let fallback = await AgentLaunch.run(hasVSCode: true, folder: "/Users/alex/Code/x",
                                             prepare: { .success(bare) }, openFolder: { _ in false })
        #expect(fallback == .notOpened(prompt: "Lis le fichier /Users/alex/Code/x/.vigie/agent-a.md et suis ses consignes."))
    }

    @Test func openedHandsOverTheClaudeCodeLink() async throws {
        let result = try Self.result()
        let message = try #require(result.message)
        let link = try #require(result.openUrl.flatMap(URL.init(string:)))
        let prompt = try #require(result.prompt)
        let outcome = await AgentLaunch.run(hasVSCode: true, folder: "/Users/alex/Code/cabinet-martin",
                                            prepare: { .success(result) }, openFolder: { _ in true })
        #expect(outcome == .opened(message: message, link: link, prompt: prompt))

        // seulement Claude Code dans VS Code : une autre adresse ne s'ouvre pas d'ici
        let other = try Self.result(#"{ "ok": true, "folder": "/Users/alex/Code/x", "openUrl": "https://exemple.test", "prompt": "p" }"#)
        let safe = await AgentLaunch.run(hasVSCode: true, folder: "/Users/alex/Code/x",
                                         prepare: { .success(other) }, openFolder: { _ in true })
        #expect(safe == .opened(message: AgentLaunch.openedMessage, link: nil, prompt: "p"))
    }
}
