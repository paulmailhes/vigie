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

        func make(_ dir: String) throws {
            try FileManager.default.createDirectory(atPath: path + "/" + dir, withIntermediateDirectories: true)
        }

        func issue(_ folder: String, parent: String = "~/Code") -> String? {
            AgentFolderRule.issue(folder, parent: parent, home: path)
        }

        deinit { try? FileManager.default.removeItem(atPath: (path as NSString).deletingLastPathComponent) }
    }

    private static let outsideHome = "Dossier refusé : il doit être dans ton dossier perso."
    private static let homeItself = "Dossier refusé : choisis un dossier dans ton dossier perso, pas le dossier perso lui-même."
    private static let unreadable = "Dossier refusé : chemin trop long ou illisible. Choisis un autre dossier avec « Choisir… »."
    /// La raison de chaque dossier réservé, la même que dans le moteur (lib/agents.mjs).
    private static let reasons = [
        ".vigie": "dossier de Vigie",
        "Library": "réglages du Mac et des apps, iCloud Drive et Dropbox compris",
        ".claude": "réglages de Claude Code",
        ".claude-comptes": "comptes Claude Code de Vigie",
        ".ssh": "tes clés",
        ".codex": "réglages de Codex",
    ]
    private static func reserved(_ name: String) -> String {
        "Dossier refusé : ~/\(name) est réservé (\(reasons[name] ?? "?")). Choisis un dossier ailleurs, dans ~/Code par exemple."
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

    /// Le dossier perso lui-même : la phrase du moteur, avant celle du dossier parent (même quand l'agent propose ~).
    @Test func refusesHomeAndParentThemselves() throws {
        let home = try FakeHome()
        #expect(home.issue("~") == Self.homeItself)
        #expect(home.issue("~/") == Self.homeItself)
        #expect(home.issue("~", parent: "~") == Self.homeItself)
        #expect(home.issue(home.path, parent: home.path) == Self.homeItself)
        #expect(home.issue("~/Code/") == "Choisis un dossier rien que pour ce projet, pas ~/Code lui-même.")
        #expect(home.issue(home.path + "/Code") == "Choisis un dossier rien que pour ce projet, pas ~/Code lui-même.")
    }

    @Test func refusesReservedFolders() throws {
        let home = try FakeHome()
        #expect(home.issue("~/.vigie") == Self.reserved(".vigie"))
        #expect(home.issue("~/.vigie/data/x") == Self.reserved(".vigie"))
        #expect(home.issue("~/Library/Projets") == Self.reserved("Library"))
        // iCloud Drive, tel que « Choisir… » le rend : réservé lui aussi, la raison le dit
        #expect(home.issue("~/Library/Mobile Documents/com~apple~CloudDocs/Clients/martin") == Self.reserved("Library"))
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
        #expect(home.issue(home.path.uppercased()) == Self.homeItself)
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

    /// Un lien qui mène DANS un dossier réservé, pas seulement vers lui : les parents du chemin réel comptent, comme
    /// dans le moteur. Dropbox et OneDrive rangent leurs fichiers dans ~/Library/CloudStorage, avec un lien ~/Dropbox.
    @Test func followsLinksIntoReservedSubfolders() throws {
        let home = try FakeHome()
        try home.make("Library/CloudStorage/Dropbox/Clients")
        try home.make(".ssh/client")
        try home.link("Dropbox", to: home.path + "/Library/CloudStorage/Dropbox")
        try home.link("Code/depot/la", to: home.path + "/Library/LaunchAgents")
        try home.link("Code/depot/vd", to: "../../.vigie/data")
        try home.link("Code/cles", to: home.path + "/.ssh/client")
        #expect(home.issue("~/Dropbox/Clients/martin") == Self.reserved("Library"))
        #expect(home.issue("~/Dropbox/Clients") == Self.reserved("Library"))
        #expect(home.issue("~/Code/depot/la") == Self.reserved("Library"))
        #expect(home.issue("~/Code/depot/la/x") == Self.reserved("Library"))
        #expect(home.issue("~/Code/depot/vd/agents/x") == Self.reserved(".vigie"))
        #expect(home.issue("~/Code/cles") == Self.reserved(".ssh"))
        #expect(home.issue("~/Code/cles/projet") == Self.reserved(".ssh"))
    }

    /// Ce qui doit passer passe encore : un projet ordinaire, un lien vers un dossier ordinaire du dossier perso, et
    /// ~/Code tout entier relié à un disque externe.
    @Test func acceptsOrdinaryLinks() throws {
        let home = try FakeHome()
        try home.make("Documents/Clients")
        try home.link("Code/depot/clients", to: "../../Documents/Clients")
        #expect(home.issue("~/Code/client") == nil)
        #expect(home.issue("~/Code/depot/clients/martin") == nil)
        #expect(home.issue("~/Code/depot/clients") == nil)

        let external = try FakeHome(without: ["Code/depot"])
        try external.link("Code", to: external.outside)
        #expect(external.issue("~/Code/martin") == nil)
        #expect(external.issue("~/Code/martin/site") == nil)
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

/// Ce que dit le moteur avant le lancement : ce que crée l'agent, où il peut s'ouvrir, et ce qu'il y a dans le dossier.
struct AgentFormTests {
    @Test func decodesCreatesAndSurfaces() throws {
        let json = """
        { "surfaces": { "available": ["vscode", "oups", "claude-app", "vscode"], "chosen": "claude-app" },
          "agents": [ { "id": "demarrer-projet", "creates": ["Le dossier du projet", "  ", 3, "Le fichier Figma"],
                        "fields": [ { "id": "brief", "type": "longtext" } ] },
                      { "id": "ancien" } ] }
        """
        let library = try JSONDecoder().decode(AgentLibrary.self, from: Data(json.utf8))
        // une valeur inconnue (moteur plus récent) ou en double est ignorée
        #expect(library.surfaces?.available == [.vscode, .claudeApp])
        #expect(library.surfaces?.chosen == .claudeApp)
        let agent = try #require(library.agents.first)
        #expect(agent.willCreate == ["Le dossier du projet", "Le fichier Figma"])
        #expect(agent.dropField?.id == "brief")
        #expect(library.agents[1].creates.isEmpty)
        // moteur plus ancien : ni surfaces ni creates, la feuille marche quand même
        let old = try JSONDecoder().decode(AgentLibrary.self, from: Data(#"{ "agents": [ { "id": "a" } ] }"#.utf8))
        #expect(old.surfaces == nil)
        #expect(old.agents.first?.willCreate == [])
    }

    @Test func prefersTheLastUsedSurfaceWhileItIsThere() {
        #expect(AgentSurfaces(available: [.vscode, .claudeApp], chosen: .claudeApp).preferred == .claudeApp)
        // l'app Claude retirée depuis : le premier disponible
        #expect(AgentSurfaces(available: [.vscode], chosen: .claudeApp).preferred == .vscode)
        #expect(AgentSurfaces(available: [.claudeApp], chosen: nil).preferred == .claudeApp)
        #expect(AgentSurfaces(available: [], chosen: .vscode).preferred == nil)
    }

    /// Les fichiers se glissent dans le premier long texte ; à défaut, dans le premier champ d'adresses.
    @Test func picksTheFieldThatTakesFiles() throws {
        func agent(_ fields: String) throws -> AgentInfo {
            try JSONDecoder().decode(AgentInfo.self, from: Data(#"{ "id": "a", "fields": [\#(fields)] }"#.utf8))
        }
        let mixed = try agent(#"{ "id": "refs", "type": "urls" }, { "id": "client", "type": "text" }, { "id": "notes", "type": "longtext" }"#)
        #expect(mixed.dropField?.id == "notes")
        #expect(try agent(#"{ "id": "refs", "type": "urls" }, { "id": "client" }"#).dropField?.id == "refs")
        #expect(try agent(#"{ "id": "client" }"#).dropField == nil)
    }

    @Test func decodesTheFolder() throws {
        let json = """
        { "path": "/Users/alex/Code/cabinet-martin", "exists": true, "error": null,
          "conversations": [ { "id": "c1", "title": "Brief", "lastActivity": "2026-10-26T21:09:00.000Z", "running": true, "surface": "vscode" },
                             { "id": "c2", "title": "", "lastActivity": 1793000000000, "surface": "claude-app" },
                             { "title": "sans id" } ],
          "sources": ["charte.pdf", 4, "plaquette.pdf"] }
        """
        let info = try JSONDecoder().decode(AgentFolderInfo.self, from: Data(json.utf8))
        #expect(info.exists && info.problem == nil)
        #expect(info.conversations.map(\.id) == ["c1", "c2"])
        #expect(info.conversations[0].running && info.conversations[0].lastActivity != nil)
        #expect(info.conversations[1].title == nil && !info.conversations[1].running && info.conversations[1].lastActivity != nil)
        #expect(info.sources == ["charte.pdf", "plaquette.pdf"])
        #expect(info.note == ("Dossier existant · 2 fichiers dans sources/", false))

        // dossier refusé : la raison en orange, rien à continuer
        let refused = try JSONDecoder().decode(AgentFolderInfo.self, from: Data("""
        { "path": "/Users/alex/.ssh", "exists": true, "error": "Dossier refusé : ~/.ssh est réservé (tes clés).",
          "conversations": [ { "id": "c" } ], "sources": [] }
        """.utf8))
        #expect(refused.note == ("Dossier refusé : ~/.ssh est réservé (tes clés).", true))
        #expect(refused.resumable.isEmpty)

        #expect(AgentFolderInfo(exists: false).note == ("Nouveau dossier : Vigie le crée.", false))
        #expect(AgentFolderInfo(exists: true).note == ("Dossier existant : Vigie y range la consigne de l'agent.", false))
        #expect(AgentFolderInfo(exists: true, sources: ["a"]).note.text == "Dossier existant · 1 fichier dans sources/")
        #expect(AgentFolderInfo(exists: true, sources: Array(repeating: "x", count: 50)).note.text
            == "Dossier existant · 50 fichiers ou plus dans sources/")
        // champs absents : rien ne tombe
        let bare = try JSONDecoder().decode(AgentFolderInfo.self, from: Data("{}".utf8))
        #expect(!bare.exists && bare.conversations.isEmpty && bare.sources.isEmpty && bare.problem == nil)
    }

    /// Le chemin entier arrive au moteur, même avec « & », « + » (lu comme une espace sinon) ou « # ».
    @Test func asksForTheWholePath() {
        #expect(AgentFolderInfo.route("/Users/alex/Code/cabinet-martin") == "/api/v2/agents/folder?path=/Users/alex/Code/cabinet-martin")
        let odd = AgentFolderInfo.route("/Users/alex/Code/Martin & Fils+co #2?é=1")
        #expect(odd == "/api/v2/agents/folder?path=/Users/alex/Code/Martin%20%26%20Fils%2Bco%20%232%3F%C3%A9%3D1")
        let read = URLComponents(string: "http://127.0.0.1:4777" + odd)?.queryItems?.first { $0.name == "path" }?.value
        #expect(read == "/Users/alex/Code/Martin & Fils+co #2?é=1")
    }

    @Test func describesAConversation() throws {
        let now = try #require(ISODates.parse("2026-10-26T23:10:00Z"))
        let earlier = ISODates.parse("2026-10-26T21:09:00Z")
        #expect(AgentConversation(id: "c", title: "Brief", lastActivity: earlier, running: true, surface: "vscode").summary(now: now)
            == "« Brief » · il y a 2 h · VS Code (en cours)")
        #expect(AgentConversation(id: "c", surface: "claude-app").summary(now: now) == "Conversation sans titre · l'app Claude")
        #expect(AgentConversation(id: "c", surface: "terminal").summary(now: now) == "Conversation sans titre · Terminal")
        #expect(AgentConversation(id: "c", title: "T", running: true, surface: "autre").summary(now: now) == "« T » · en cours")
    }
}

/// « Lancer » : la conversation à continuer, le bouton, ce qui part au moteur et ce qu'on fait de sa réponse. C'est le
/// moteur qui ouvre VS Code ou l'app Claude ; l'app copie seulement le message quand il n'a pas pu être prérempli.
struct AgentLaunchTests {
    private static let prompt = "Lance l'agent « Démarrer un projet client » : lis le fichier /Users/alex/Code/cabinet-martin/.vigie/agent-demarrer-projet.md et suis ses consignes, dans le dossier /Users/alex/Code/cabinet-martin."

    /// La réponse du moteur à un lancement réussi (lib/agents.mjs, launch).
    private static func launched(_ opened: String, surface: String = "vscode", message: String? = nil) throws -> WriteResult {
        let said = message.map { ", \"message\": \"\($0)\"" } ?? ""
        let json = """
        { "ok": true, "folder": "/Users/alex/Code/cabinet-martin",
          "briefFile": "/Users/alex/Code/cabinet-martin/.vigie/agent-demarrer-projet.md",
          "prompt": "\(prompt)", "surface": "\(surface)", "opened": "\(opened)",
          "copied": ["sources/charte.pdf", "sources/plaquette (2).pdf"]\(said) }
        """
        return try JSONDecoder().decode(WriteResult.self, from: Data(json.utf8))
    }

    @Test func continuesTheLatestConversationByDefault() {
        let info = AgentFolderInfo(exists: true, conversations: [AgentConversation(id: "recente"), AgentConversation(id: "ancienne")])
        #expect(AgentLaunch.session(info, pick: nil, startNew: false) == "recente")
        #expect(AgentLaunch.session(info, pick: "ancienne", startNew: false) == "ancienne")
        // une conversation qui n'est plus dans le dossier : la plus récente
        #expect(AgentLaunch.session(info, pick: "partie", startNew: false) == "recente")
        #expect(AgentLaunch.session(info, pick: "recente", startNew: true) == nil)
        #expect(AgentLaunch.session(AgentFolderInfo(exists: true), pick: nil, startNew: false) == nil)
        // pas de réponse du moteur (plus ancien, injoignable) : nouvelle conversation
        #expect(AgentLaunch.session(nil, pick: "recente", startNew: false) == nil)
        let refused = AgentFolderInfo(exists: true, error: "Dossier refusé.", conversations: [AgentConversation(id: "x")])
        #expect(AgentLaunch.session(refused, pick: "x", startNew: false) == nil)
    }

    @Test func namesTheButton() {
        #expect(AgentLaunch.buttonTitle(surface: .vscode, continuing: false) == "Lancer dans VS Code")
        #expect(AgentLaunch.buttonTitle(surface: .claudeApp, continuing: false) == "Lancer dans l'app Claude")
        #expect(AgentLaunch.buttonTitle(surface: .vscode, continuing: true) == "Continuer dans VS Code")
        #expect(AgentLaunch.buttonTitle(surface: .claudeApp, continuing: true) == "Continuer dans l'app Claude")
        #expect(AgentLaunch.buttonTitle(surface: nil, continuing: false) == "Lancer")
    }

    /// `files`, `surface`, `session` et `mcp` ne partent que s'ils disent quelque chose.
    @Test func sendsOnlyWhatIsChosen() {
        let full = AgentLaunch.body(agent: "demarrer-projet", values: ["brief": "Bonjour"], folder: "/Users/alex/Code/cabinet-martin",
                                    files: ["/Users/alex/Downloads/charte.pdf"], surface: .claudeApp, session: "c1",
                                    mcp: ["figma": "figma-pro"])
        #expect(full == ["id": "demarrer-projet", "values": ["brief": "Bonjour"], "folder": "/Users/alex/Code/cabinet-martin",
                         "files": ["/Users/alex/Downloads/charte.pdf"], "surface": "claude-app", "session": "c1",
                         "mcp": ["figma": "figma-pro"]])
        let bare = AgentLaunch.body(agent: "a", values: [:], folder: "/Users/alex/Code/x", files: [], surface: nil, session: nil)
        #expect(bare == ["id": "a", "values": [:], "folder": "/Users/alex/Code/x"])
    }

    @Test func readsTheLaunchAnswer() throws {
        let result = try Self.launched("full")
        #expect(result.opened == "full")
        #expect(result.surface == "vscode")
        #expect(result.copied == ["sources/charte.pdf", "sources/plaquette (2).pdf"])
        #expect(result.prompt == Self.prompt)
    }

    /// Message prérempli : rien à copier, la feuille se ferme et le toast dit de l'envoyer.
    @Test func fullOpeningCopiesNothing() throws {
        let said = AgentLaunch.outcome(.success(try Self.launched("full", message: "VS Code s'ouvre.")), surface: .vscode)
        #expect(said == .launched(message: "VS Code s'ouvre.", copy: nil, alert: false))
        // sans phrase du moteur : celle de l'endroit où il a ouvert (sa réponse prime sur le choix de la feuille)
        let app = AgentLaunch.outcome(.success(try Self.launched("full", surface: "claude-app")), surface: .vscode)
        #expect(app == .launched(message: "L'app Claude s'ouvre sur le projet, avec le message prêt : envoie-le.", copy: nil, alert: false))
    }

    /// Le message n'a pas pu être prérempli : il est copié. Rien ne s'est ouvert : le toast est une alerte.
    @Test func otherOpeningsCopyThePrompt() throws {
        let folder = AgentLaunch.outcome(.success(try Self.launched("folder")), surface: .vscode)
        #expect(folder == .launched(message: "VS Code est ouvert sur le projet, mais Claude Code n'a pas répondu à temps : le message est copié, colle-le dans Claude Code et envoie-le.",
                                    copy: Self.prompt, alert: false))
        let resumed = AgentLaunch.outcome(.success(try Self.launched("no-prompt", surface: "claude-app")), surface: .claudeApp)
        #expect(resumed == .launched(message: "La conversation s'ouvre dans l'app Claude : le message est copié, colle-le (⌘V) et envoie-le.",
                                     copy: Self.prompt, alert: false))
        let none = AgentLaunch.outcome(.success(try Self.launched("none")), surface: .vscode)
        #expect(none == .launched(message: "Le dossier est prêt, mais rien ne s'est ouvert : le message est copié, colle-le dans Claude Code.",
                                  copy: Self.prompt, alert: true))
        // une valeur inconnue (moteur plus récent) : la phrase du moteur, et le message copié par prudence
        let future = AgentLaunch.outcome(.success(try Self.launched("ailleurs", message: "Ouvert ailleurs.")), surface: .vscode)
        #expect(future == .launched(message: "Ouvert ailleurs.", copy: Self.prompt, alert: false))
    }

    /// Moteur plus ancien (pas de `opened`) : il a préparé le dossier sans rien ouvrir. Sa phrase (« VS Code s'ouvre »)
    /// serait fausse : le message est copié, et le toast dit quoi faire et de mettre Vigie à jour.
    @Test func olderEngineCopiesAndSaysToUpdate() throws {
        let old = try JSONDecoder().decode(WriteResult.self, from: Data("""
        { "ok": true, "folder": "/Users/alex/Code/x", "briefFile": "/Users/alex/Code/x/.vigie/agent-a.md",
          "openUrl": "vscode://anthropic.claude-code/open?prompt=x", "prompt": "Lance l'agent",
          "message": "Dossier prêt : VS Code s'ouvre, envoie le message préparé pour lancer l'agent." }
        """.utf8))
        #expect(AgentLaunch.outcome(.success(old), surface: nil) == .launched(message: AgentLaunch.legacyMessage, copy: "Lance l'agent", alert: false))
        #expect(AgentLaunch.legacyMessage.contains("Mets Vigie à jour"))
        // sans « prompt » : un message de secours qui nomme la consigne
        let bare = try JSONDecoder().decode(WriteResult.self, from: Data(
            #"{ "ok": true, "folder": "/Users/alex/Code/x", "briefFile": "/Users/alex/Code/x/.vigie/agent-a.md" }"#.utf8))
        #expect(AgentLaunch.outcome(.success(bare), surface: nil)
            == .launched(message: AgentLaunch.legacyMessage, copy: "Lis le fichier /Users/alex/Code/x/.vigie/agent-a.md et suis ses consignes.", alert: false))
    }

    /// Le refus du moteur revient à la feuille (qui le montre et reste ouverte), pas au toast de la fenêtre.
    @Test func refusalGoesBackToTheSheet() {
        let refusal = "Fichier joint introuvable : charte.pdf."
        #expect(AgentLaunch.outcome(.failure(.refused(refusal)), surface: .vscode) == .refused(refusal))
        #expect(AgentLaunch.outcome(.failure(.unreachable), surface: .vscode) == .refused(ClientError.unreachable.message))
    }
}

/// Les fichiers joints de la feuille : sans doublon, 50 au plus, retirés à la demande.
struct AgentAttachmentsTests {
    private static func file(_ path: String, size: Int64 = 1000, copy: Bool = false) -> AgentAttachment {
        AgentAttachment(path: path, size: size, isFolder: false, isCopy: copy)
    }

    @Test func addsWithoutDuplicates() {
        var list = AgentAttachments()
        #expect(list.add([Self.file("/Users/alex/Downloads/charte.pdf"), Self.file("/Users/alex/Downloads/plaquette.pdf")]) == nil)
        // le même fichier glissé deux fois, ou écrit avec d'autres majuscules (le disque ne les distingue pas)
        #expect(list.add([Self.file("/Users/alex/Downloads/charte.pdf"), Self.file("/Users/alex/downloads/CHARTE.pdf")]) == nil)
        #expect(list.paths == ["/Users/alex/Downloads/charte.pdf", "/Users/alex/Downloads/plaquette.pdf"])
        // la même pièce jointe de Mail déposée deux fois : deux copies, une seule ligne ; même nom, autre taille : une autre
        let copies = "/private/var/folders/xy/T/vigie-fichiers-joints/A"
        list.add([Self.file(copies + "/1/devis.pdf", size: 52_000, copy: true)])
        list.add([Self.file(copies + "/2/devis.pdf", size: 52_000, copy: true)])
        list.add([Self.file(copies + "/3/devis.pdf", size: 61_000, copy: true)])
        #expect(list.items.map(\.name) == ["charte.pdf", "plaquette.pdf", "devis.pdf", "devis.pdf"])
        #expect(list.items.last?.path == copies + "/3/devis.pdf")
    }

    @Test func removesAndAllowsAddingAgain() {
        var list = AgentAttachments([Self.file("/Users/alex/a.pdf"), Self.file("/Users/alex/b.pdf")])
        #expect(list.remove("/Users/alex/a.pdf")?.name == "a.pdf")
        #expect(list.remove("/Users/alex/absent.pdf") == nil)
        #expect(list.paths == ["/Users/alex/b.pdf"])
        list.add([Self.file("/Users/alex/a.pdf")])
        #expect(list.paths == ["/Users/alex/b.pdf", "/Users/alex/a.pdf"])
    }

    @Test func stopsAtFifty() {
        var list = AgentAttachments()
        #expect(list.add((1...52).map { Self.file("/Users/alex/f\($0).pdf") }) == AgentAttachments.tooMany)
        #expect(list.items.count == AgentAttachments.maxCount)
        // un doublon n'est pas un fichier de trop
        #expect(list.add([Self.file("/Users/alex/f1.pdf")]) == nil)
    }

    @Test func describesEachLine() {
        #expect(AgentAttachment(path: "/Users/alex/Projets", size: nil, isFolder: true, isCopy: false).detail == "Dossier")
        #expect(Self.file("/Users/alex/a.pdf", size: 248_000).detail.contains("248"))
        #expect(Self.file("/Users/alex/Downloads/Questionnaire client.pdf").name == "Questionnaire client.pdf")
    }

    /// iCloud Drive, Dropbox et les téléchargements de Mail sont dans ~/Library, que le moteur refuse : Vigie en copie
    /// les fichiers ; pas un dossier entier.
    /// Ce que macOS protège ou que le moteur refuse est copié par l'app ; le reste du dossier perso part tel quel.
    @Test func copiesWhatTheEngineCannotRead() {
        let home = "/Users/alex"
        #expect(AgentAttachment.needsCopy("/Users/alex/Library/Mobile Documents/com~apple~CloudDocs/brief.pdf", isFolder: false, home: home))
        #expect(AgentAttachment.needsCopy("/Users/alex/library/CloudStorage/Dropbox/charte.pdf", isFolder: false, home: home))
        #expect(AgentAttachment.needsCopy("/Users/alex/Library/CloudStorage/Dropbox/Clients", isFolder: true, home: home))
        #expect(AgentAttachment.needsCopy("/Users/alex/Downloads/brief.pdf", isFolder: false, home: home))
        #expect(AgentAttachment.needsCopy("/Users/alex/Desktop/plaquette.pdf", isFolder: false, home: home))
        #expect(AgentAttachment.needsCopy("/Users/alex/Documents/Clients/Martin", isFolder: true, home: home))
        #expect(AgentAttachment.needsCopy("/Volumes/Cle/brief.pdf", isFolder: false, home: home))
        #expect(!AgentAttachment.needsCopy("/Users/alex/Code/cabinet-martin/brand/logo.svg", isFolder: false, home: home))
        #expect(!AgentAttachment.needsCopy("/Users/alex/Code/cabinet-martin/brand", isFolder: true, home: home))
    }

    /// Un vrai fichier et un vrai dossier, lus dans le dossier temporaire.
    @Test func readsFromDisk() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "vigie-essai-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root.appending(path: "dossier"), withIntermediateDirectories: true)
        try Data(count: 1234).write(to: root.appending(path: "charte.pdf"))
        let file = try #require(AgentAttachment.read(root.appending(path: "charte.pdf")))
        #expect(file.size == 1234 && !file.isFolder && !file.isCopy && file.name == "charte.pdf")
        let folder = try #require(AgentAttachment.read(root.appending(path: "dossier"), isCopy: true))
        #expect(folder.isFolder && folder.size == nil && folder.isCopy)
        #expect(AgentAttachment.read(root.appending(path: "absent.pdf")) == nil)
    }

    /// Avant de copier : les refus du moteur que la copie par l'app effacerait (lien, ~/Library, dossier perso entier,
    /// lien physique) ; iCloud Drive et Dropbox restent permis.
    @Test func refusesBeforeCopying() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "vigie-essai-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let home = root.appending(path: "maison")
        let fm = FileManager.default
        for dir in ["Desktop", "Library/Keychains", "Library/Mobile Documents/com~apple~CloudDocs", "Library/CloudStorage/Dropbox"] {
            try fm.createDirectory(at: home.appending(path: dir), withIntermediateDirectories: true)
        }
        let plaquette = home.appending(path: "Desktop/plaquette.pdf")
        try Data(count: 10).write(to: plaquette)
        try Data(count: 10).write(to: home.appending(path: "Library/Keychains/login.keychain-db"))
        try Data(count: 10).write(to: home.appending(path: "Library/Mobile Documents/com~apple~CloudDocs/brief.pdf"))
        try fm.createSymbolicLink(at: home.appending(path: "Desktop/raccourci.pdf"), withDestinationURL: plaquette)
        try fm.linkItem(at: plaquette, to: home.appending(path: "Desktop/autre-nom.pdf"))
        let h = home.path(percentEncoded: false)
        func refusal(_ p: String) -> String? { AgentAttachment.refusal(home.appending(path: p), home: h) }
        #expect(refusal("Desktop/raccourci.pdf")?.contains("est un lien") == true)
        #expect(refusal("Desktop/autre-nom.pdf")?.contains("lien physique") == true)
        #expect(refusal("Library/Keychains/login.keychain-db")?.contains("~/Library") == true)
        #expect(refusal("Library/Mobile Documents/com~apple~CloudDocs/brief.pdf") == nil, "iCloud Drive : permis")
        #expect(refusal("Library/CloudStorage/Dropbox") == nil, "Dropbox : permis")
        #expect(AgentAttachment.refusal(home, home: h)?.contains("dossier perso") == true)
        #expect(AgentAttachment.refusal(root, home: h)?.contains("dossier perso") == true, "un dossier qui contient le dossier perso")
        #expect(refusal("Desktop/absent.pdf")?.contains("introuvable") == true)
        try fm.removeItem(at: home.appending(path: "Desktop/autre-nom.pdf"))
        #expect(refusal("Desktop/plaquette.pdf") == nil)
        // limites du moteur : un dossier de 5 001 fichiers est trop gros ; un petit dossier non
        let many = root.appending(path: "beaucoup")
        try fm.createDirectory(at: many, withIntermediateDirectories: true)
        for i in 0...AgentAttachment.maxFiles { fm.createFile(atPath: many.appending(path: "\(i).txt").path(percentEncoded: false), contents: nil) }
        #expect(AgentAttachment.tooBig(many))
        #expect(!AgentAttachment.tooBig(home.appending(path: "Desktop")))
        #expect(!AgentAttachment.tooBig(plaquette))
    }

    /// Deux copies venues de deux endroits (deux dossiers « Logos ») restent deux ; la même, déposée deux fois, une seule.
    @Test func copiesDedupeOnTheirOrigin() {
        let a = AgentAttachment(path: "/tmp/v/1/Logos", size: nil, isFolder: true, isCopy: true, origin: "/Users/alex/Desktop/Martin/Logos")
        let b = AgentAttachment(path: "/tmp/v/2/Logos", size: nil, isFolder: true, isCopy: true, origin: "/Users/alex/Desktop/Dupont/Logos")
        let again = AgentAttachment(path: "/tmp/v/3/Logos", size: nil, isFolder: true, isCopy: true, origin: "/Users/alex/Desktop/Martin/Logos")
        var list = AgentAttachments([a])
        list.add([b, again])
        #expect(list.items.map(\.path) == ["/tmp/v/1/Logos", "/tmp/v/2/Logos"])
    }
}

/// La lecture du dossier : 400 ms après la dernière frappe, annulée si le dossier change encore.
@MainActor
struct AgentFolderCheckTests {
    @MainActor
    private final class Log {
        var slept: [Duration] = []
        var reads = 0
    }

    @Test func waitsThenReads() async {
        let log = Log()
        let value = await AgentFolderCheck.afterPause(AgentFolderCheck.pause, sleep: { log.slept.append($0) },
                                                      read: { log.reads += 1; return 7 })
        #expect(value == 7)
        #expect(log.slept == [.milliseconds(400)])
        #expect(log.reads == 1)
    }

    /// La première lecture (la feuille s'ouvre sur un dossier) part tout de suite.
    @Test func firstReadDoesNotWait() async {
        let log = Log()
        let value = await AgentFolderCheck.afterPause(.zero, sleep: { log.slept.append($0) }, read: { log.reads += 1; return "dossier" })
        #expect(value == "dossier")
        #expect(log.slept.isEmpty)
    }

    /// Une frappe de plus pendant l'attente annule la lecture : le moteur n'est pas appelé.
    @Test func cancelledDuringThePauseReadsNothing() async {
        let log = Log()
        let task = Task { @MainActor in
            await AgentFolderCheck.afterPause(AgentFolderCheck.pause, read: { log.reads += 1; return 1 })
        }
        task.cancel()
        #expect(await task.value == nil)
        #expect(log.reads == 0)
    }
}
