import Foundation
import Testing
@testable import Vigie

/// Les bibliothèques d'agents (un dépôt git, un dossier par agent) : ce que l'app lit du moteur, ce qu'elle en dit,
/// et l'adresse vérifiée dans la feuille avant l'envoi (le moteur reste l'arbitre).
struct AgentLibraryTests {
    private static let now = ISODates.parse("2026-10-19T23:20:00Z")!

    // MARK: Décodage

    /// `source` de chaque agent : une bibliothèque seulement si elle est nommée ; le reste (absent, local, illisible,
    /// d'un autre genre) est un agent local.
    @Test func decodesWhereEachAgentComesFrom() throws {
        let json = """
        { "agents": [
            { "id": "demarrer-projet", "source": { "kind": "library", "id": "studio-agents", "name": "Studio" } },
            { "id": "revue-seo", "source": { "kind": "local" } },
            { "id": "ancien" },
            { "id": "texte", "source": "library" },
            { "id": "futur", "source": { "kind": "plugin", "id": "x" } },
            { "id": "sans-nom", "source": { "kind": "library", "id": "outils", "name": null } },
            { "id": "anonyme", "source": { "kind": "library", "name": "  " } },
            { "id": "nul", "source": null } ] }
        """
        let page = try JSONDecoder().decode(AgentsPage.self, from: Data(json.utf8))
        #expect(page.agents.map(\.id) == ["demarrer-projet", "revue-seo", "ancien", "texte", "futur", "sans-nom", "anonyme", "nul"])
        #expect(page.agents.map(\.libraryName) == ["Studio", nil, nil, nil, nil, "outils", nil, nil])
        #expect(page.agents[0].source?.libraryID == "studio-agents")
        #expect(page.agents[5].source?.libraryID == "outils")
        #expect(page.agents.filter { $0.source?.isLibrary == true }.map(\.id) == ["demarrer-projet", "sans-nom"])
        // le genre dit par le moteur est gardé (il repart au lancement) ; illisible : local
        #expect(page.agents.map { $0.source?.kind } == ["library", "local", nil, "local", "plugin", "library", "library", nil])
        // un agent d'une bibliothèque se lance comme un autre
        #expect(page.agents.allSatisfy { $0.canLaunch })
    }

    /// `libraries` : absente (moteur plus ancien) = nil, la section ne s'affiche pas ; une bibliothèque illisible ne
    /// fait pas tomber les autres ; un statut inconnu compte comme une erreur, sans rien bloquer.
    @Test func decodesLibrariesTolerantly() throws {
        let json = """
        { "dir": "/Users/alex/.vigie/data/agents",
          "agents": [ { "id": "a", "source": { "kind": "library", "id": "outils" } } ],
          "libraries": [
            { "id": "studio-agents", "name": "Studio", "url": "https://github.com/studio/agents", "addedAt": "2026-10-12T09:30:00.000Z",
              "updatedAt": 1760907900000, "commit": "4f2a9c1", "status": "ok", "error": null, "agents": 3, "champInconnu": { "x": 1 } },
            { "id": "outils", "url": "git@github.com:studio/outils.git", "status": "error",
              "error": "Dépôt introuvable, ou git n'a pas accès : vérifie l'adresse.", "agents": "deux", "updatedAt": "pas une date" },
            { "id": "futur", "status": "en-pause", "error": "" },
            { "id": "en-cours", "status": "updating", "error": "Ancienne erreur" },
            { "id": "muet", "status": "error" },
            { "id": "sans-statut", "error": "Mise à jour impossible." },
            { "id": "negatif", "agents": -2, "status": "OK" },
            { "name": "sans id" }, 4, null ] }
        """
        let page = try JSONDecoder().decode(AgentsPage.self, from: Data(json.utf8))
        let libraries = try #require(page.libraries)
        #expect(libraries.map(\.id) == ["studio-agents", "outils", "futur", "en-cours", "muet", "sans-statut", "negatif"])
        #expect(libraries.map(\.status) == [.ok, .error, .error, .updating, .error, .error, .ok])

        let studio = libraries[0]
        #expect(studio.displayName == "Studio" && studio.commit == "4f2a9c1" && studio.agents == 3)
        #expect(studio.addedAt != nil && studio.updatedAt != nil)
        #expect(studio.problem == nil)
        #expect(page.agentCount(of: studio) == 3)

        let outils = libraries[1]
        #expect(outils.displayName == "outils" && outils.updatedAt == nil && outils.agents == nil)
        #expect(outils.problem == "Dépôt introuvable, ou git n'a pas accès : vérifie l'adresse.")
        // sans nombre du moteur : compté dans la liste
        #expect(page.agentCount(of: outils) == 1)

        // statut inconnu ou erreur sans phrase : une phrase qui dit quoi faire
        #expect(libraries[2].problem == AgentLibraryInfo.failedUpdate)
        #expect(libraries[4].problem == AgentLibraryInfo.failedUpdate)
        // en cours : l'ancienne erreur ne s'affiche pas
        #expect(libraries[3].problem == nil)
        #expect(libraries[5].problem == "Mise à jour impossible.")
        #expect(libraries[6].agents == 0)
    }

    @Test func olderEngineHasNoLibraries() throws {
        func libraries(_ json: String) throws -> [AgentLibraryInfo]? {
            try JSONDecoder().decode(AgentsPage.self, from: Data(json.utf8)).libraries
        }
        let old = try JSONDecoder().decode(AgentsPage.self, from: Data(#"{ "agents": [ { "id": "a" } ] }"#.utf8))
        #expect(old.libraries == nil)
        #expect(old.agents.first?.libraryName == nil)
        #expect(try libraries(#"{ "agents": [], "libraries": null }"#) == nil)
        #expect(try libraries(#"{ "agents": [], "libraries": "oups" }"#) == nil)
        #expect(try libraries(#"{ "agents": [], "libraries": [] }"#) == [])
    }

    // MARK: Libellés

    @Test func summarizesALibrary() {
        let now = Self.now
        let twoHours = now.addingTimeInterval(-2 * 3600 - 300)
        #expect(AgentLibraryInfo(id: "a", updatedAt: twoHours).summary(now: now, count: 3) == "Mise à jour il y a 2 h · 3 agents")
        #expect(AgentLibraryInfo(id: "a", updatedAt: twoHours).summary(now: now, count: 1) == "Mise à jour il y a 2 h · 1 agent")
        #expect(AgentLibraryInfo(id: "a", updatedAt: now.addingTimeInterval(-20)).summary(now: now, count: 2)
            == "Mise à jour à l'instant · 2 agents")
        #expect(AgentLibraryInfo(id: "a", updatedAt: now.addingTimeInterval(-720)).summary(now: now, count: 2)
            == "Mise à jour il y a 12 min · 2 agents")
        // en cours : plus d'âge, la mise à jour se fait
        #expect(AgentLibraryInfo(id: "a", updatedAt: twoHours, status: .updating).summary(now: now, count: 3)
            == "Mise à jour en cours… · 3 agents")
        // jamais mise à jour : depuis quand elle est là
        #expect(AgentLibraryInfo(id: "a", addedAt: now.addingTimeInterval(-3 * 86_400)).summary(now: now, count: 0)
            == "Ajoutée il y a 3 j · aucun agent")
        #expect(AgentLibraryInfo(id: "a").summary(now: now, count: 0) == "Aucun agent")
        #expect(AgentLibraryInfo(id: "a").summary(now: now, count: 4) == "4 agents")
        // une mise à jour ratée garde son âge : la dernière bonne copie sert toujours
        #expect(AgentLibraryInfo(id: "a", updatedAt: twoHours, status: .error, error: "Oups.").summary(now: now, count: 2)
            == "Mise à jour il y a 2 h · 2 agents")
    }

    /// « propriétaire/dépôt » (deux dépôts du même nom restent distincts) : à l'écran, coupé après « / » s'il faut deux
    /// lignes, jamais après un trait d'union.
    @Test func namesALibraryByOwnerAndRepository() throws {
        let json = """
        { "agents": [ { "id": "a", "source": { "kind": "library", "id": "studio-agents", "name": "studio/agents" } },
                      { "id": "b", "source": { "kind": "library", "id": "agents", "name": "alex/agents" } } ],
          "libraries": [ { "id": "studio-agents", "name": "studio/agents" }, { "id": "agents", "name": "alex/agents" } ] }
        """
        let page = try JSONDecoder().decode(AgentsPage.self, from: Data(json.utf8))
        #expect(page.libraries?.map(\.displayName) == ["studio/agents", "alex/agents"])
        #expect(page.agents.map(\.libraryName) == ["studio/agents", "alex/agents"])

        #expect(AgentLibraryName.wrapping("studio/agents") == "studio/\u{200B}agents")
        #expect(AgentLibraryName.wrapping("mon-studio/agents-figma") == "mon-\u{2060}studio/\u{200B}agents-\u{2060}figma")
        #expect(AgentLibraryName.wrapping("agents") == "agents")
        // les caractères ajoutés ne se voient pas : le texte affiché reste le nom
        let shown = AgentLibraryName.wrapping("mon-studio/agents-figma").unicodeScalars.filter { !["\u{200B}", "\u{2060}"].contains($0) }
        #expect(String(String.UnicodeScalarView(shown)) == "mon-studio/agents-figma")
    }

    @Test func shortensTheAddress() {
        #expect(AgentLibraryAddress.short("https://github.com/studio/agents") == "github.com/studio/agents")
        #expect(AgentLibraryAddress.short("https://github.com/studio/agents.git") == "github.com/studio/agents")
        #expect(AgentLibraryAddress.short("https://github.com/studio/agents/") == "github.com/studio/agents")
        #expect(AgentLibraryAddress.short("git@github.com:studio/agents.git") == "github.com/studio/agents")
        #expect(AgentLibraryAddress.short("ssh://git@gitlab.com/studio/agents.git") == "gitlab.com/studio/agents")
        #expect(AgentLibraryAddress.short("ssh://git@git.studio.fr:2222/equipe/agents") == "git.studio.fr:2222/equipe/agents")
        #expect(AgentLibraryInfo(id: "a", url: "https://github.com/studio/agents.git").shortURL == "github.com/studio/agents")
        #expect(AgentLibraryInfo(id: "a").shortURL == nil)
    }

    /// Un lien vers la page du dépôt, seulement pour une adresse https sans identifiant.
    @Test func linksToTheRepositoryPage() {
        #expect(AgentLibraryAddress.webPage("https://github.com/studio/agents.git")?.absoluteString == "https://github.com/studio/agents")
        #expect(AgentLibraryAddress.webPage("https://github.com/studio/agents")?.absoluteString == "https://github.com/studio/agents")
        #expect(AgentLibraryAddress.webPage("git@github.com:studio/agents.git") == nil)
        #expect(AgentLibraryAddress.webPage("ssh://git@github.com/studio/agents") == nil)
        #expect(AgentLibraryAddress.webPage("https://alex:jeton@github.com/studio/agents") == nil)
        #expect(AgentLibraryAddress.webPage("file:///Users/alex/agents") == nil)
    }

    // MARK: L'adresse, dans la feuille

    @Test func acceptsRepositoryAddresses() {
        let ready = [
            "https://github.com/studio/agents",
            "https://github.com/studio/agents.git",
            "  https://gitlab.com/studio/equipe/agents  ",
            "HTTPS://GitHub.com/Studio/Agents",
            "git@github.com:studio/agents.git",
            "ssh://git@github.com/studio/agents.git",
        ]
        for address in ready {
            #expect(AgentLibraryAddress.check(address) == .ready(address.trimmingCharacters(in: .whitespaces)), "\(address)")
        }
        // copiée sans « https:// » : ajoutée
        #expect(AgentLibraryAddress.check("github.com/studio/agents") == .ready("https://github.com/studio/agents"))
        #expect(AgentLibraryAddress.normalized(" github.com/studio/agents ") == "https://github.com/studio/agents")
        #expect(AgentLibraryAddress.normalized("git@github.com:studio/agents.git") == "git@github.com:studio/agents.git")
    }

    /// Tant que l'adresse se tape, rien à dire : « Ajouter » reste grisé, sans message.
    @Test func waitsWhileTyping() {
        #expect(AgentLibraryAddress.check("") == .empty)
        #expect(AgentLibraryAddress.check("   ") == .empty)
        for partial in ["h", "htt", "https", "https:/", "https://", "https://github.com", "https://github.com/",
                        "g", "git", "git@", "git@github.com", "git@github.com:", "ssh://git@github.com",
                        "github", "github.com", "github.com/", "studio/agents"] {
            #expect(AgentLibraryAddress.check(partial) == .typing, "\(partial)")
        }
    }

    /// Les mêmes refus que le moteur pour ce qui se voit à l'écriture ; le reste (hôte privé…) est à lui.
    @Test func refusesWhatTheEngineRefuses() {
        let refused = AgentLibraryAddress.refused
        for address in ["file:///Users/alex/agents", "/Users/alex/agents", "~/Code/agents", "./agents", "ext::sh -c touch",
                        "-uhttps://github.com/x", "--upload-pack=x", "https://github.com/studio/mes agents",
                        "https://github.com/studio/agents\n--x", "C:\\agents", "git@:studio/agents.git",
                        "ftp://github.com/studio/agents", "https://" + String(repeating: "a", count: 2050)] {
            #expect(AgentLibraryAddress.check(address) == .refused(refused), "\(address)")
        }
        #expect(AgentLibraryAddress.check("http://github.com/studio/agents") == .refused(AgentLibraryAddress.plainHTTP))
        #expect(AgentLibraryAddress.check("http:") == .refused(AgentLibraryAddress.plainHTTP))
        #expect(AgentLibraryAddress.check("https://alex:ghp_jeton@github.com/studio/agents")
            == .refused(AgentLibraryAddress.credentials))
        #expect(AgentLibraryAddress.check("https://alex@github.com/studio/agents") == .refused(AgentLibraryAddress.credentials))
    }

    /// L'adresse d'une page du dépôt, copiée du navigateur : refusée avec la phrase qui dit quoi coller.
    @Test func refusesTheAddressOfAPage() {
        for address in ["https://github.com/studio/agents/tree/main", "https://github.com/studio/agents/blob/main/AGENT.md",
                        "https://gitlab.com/groupe/agents/-/tree/main", "github.com/studio/agents/tree/main"] {
            #expect(AgentLibraryAddress.check(address) == .refused(AgentLibraryAddress.page), "\(address)")
        }
        // un dépôt qui s'appelle « tree » ou « blob » reste un dépôt
        #expect(AgentLibraryAddress.check("https://github.com/studio/tree") == .ready("https://github.com/studio/tree"))
        #expect(AgentLibraryAddress.check("https://github.com/blob/agents") == .ready("https://github.com/blob/agents"))
    }

    // MARK: Ajouter

    /// La réponse du moteur : ajoutée, refusée (la phrase dans la feuille), ou délai dépassé (la liste relue dira).
    @Test func readsTheAddAnswer() {
        #expect(AgentLibraryAdd.outcome(.success(WriteResult(ok: true, message: "Bibliothèque ajoutée : 3 agents."))) == .added)
        #expect(AgentLibraryAdd.outcome(.failure(.timedOut)) == nil)
        #expect(AgentLibraryAdd.outcome(.failure(.refused("Cette bibliothèque est déjà là."))) == .refused("Cette bibliothèque est déjà là."))
        // dans la feuille, le bandeau « Relancer » est caché : la phrase dit où il est
        #expect(AgentLibraryAdd.outcome(.failure(.unreachable)) == .refused(AgentLibraryAdd.unreachable))
        #expect(AgentLibraryAdd.unreachable.contains("Relancer"))
    }

    /// Délai dépassé : le moteur continue. La liste relue a la bibliothèque (adresse sous une autre forme comprise) :
    /// ajoutée ; sinon toujours en cours, sans parler de panne.
    @Test func afterATimeoutLooksForTheLibrary() throws {
        func page(_ libraries: String) throws -> AgentsPage {
            try JSONDecoder().decode(AgentsPage.self, from: Data(#"{ "agents": [], "libraries": \#(libraries) }"#.utf8))
        }
        let arrived = try page(#"[ { "id": "outils", "url": "https://github.com/studio/outils" },"#
            + #" { "id": "studio-agents", "url": "https://github.com/Studio/Agents.git" } ]"#)
        let url = "git@github.com:studio/agents.git"
        #expect(AgentLibraryAdd.afterTimeout(url: url, before: ["outils"], page: arrived) == .added)
        #expect(AgentLibraryAdd.afterTimeout(url: "https://github.com/studio/agents/", before: [], page: arrived) == .added)
        // pas encore là
        #expect(AgentLibraryAdd.afterTimeout(url: "https://github.com/studio/autres", before: ["outils"], page: arrived) == .stillRunning)
        #expect(AgentLibraryAdd.afterTimeout(url: url, before: [], page: try page("[]")) == .stillRunning)
        // déjà là avant l'envoi : ce n'est pas cet ajout
        #expect(AgentLibraryAdd.afterTimeout(url: url, before: ["outils", "studio-agents"], page: arrived) == .stillRunning)
        // relecture ratée, ou moteur sans bibliothèques
        #expect(AgentLibraryAdd.afterTimeout(url: url, before: [], page: nil) == .stillRunning)
        #expect(AgentLibraryAdd.afterTimeout(url: url, before: [], page: try JSONDecoder().decode(AgentsPage.self, from: Data(#"{ "agents": [] }"#.utf8)))
            == .stillRunning)
        #expect(AgentLibraryAdd.stillRunning == "Toujours en cours : attends un instant, puis rouvre la page Agents.")
        #expect(AgentLibraryAdd.added == "Bibliothèque ajoutée.")
    }

    @Test func recognizesAnAddressWhateverItsForm() {
        let key = AgentLibraryAddress.key("https://github.com/studio/agents")
        #expect(key == "github.com/studio/agents")
        for same in ["https://github.com/studio/agents.git", "https://GitHub.com/Studio/Agents/", "git@github.com:studio/agents.git",
                     "ssh://git@github.com/studio/agents"] {
            #expect(AgentLibraryAddress.key(same) == key, "\(same)")
        }
        #expect(AgentLibraryAddress.key("https://github.com/alex/agents") != key)
    }

    // MARK: Retirer

    /// Retirée à l'instant : la rangée et ses agents disparaissent, les agents locaux et les autres bibliothèques restent.
    @Test func hidesALibraryAndItsAgents() throws {
        let json = """
        { "agents": [ { "id": "a", "source": { "kind": "library", "id": "studio" } },
                      { "id": "b", "source": { "kind": "local" } },
                      { "id": "c", "source": { "kind": "library", "id": "outils" } },
                      { "id": "d" } ],
          "libraries": [ { "id": "studio", "status": "ok" }, { "id": "outils", "status": "ok" } ] }
        """
        let page = try JSONDecoder().decode(AgentsPage.self, from: Data(json.utf8))
        let hidden = page.hiding(libraries: ["studio"])
        #expect(hidden.agents.map(\.id) == ["b", "c", "d"])
        #expect(hidden.libraries?.map(\.id) == ["outils"])
        #expect(page.hiding(libraries: []) == page)
        // moteur plus ancien : rien à cacher, la section reste absente
        let old = try JSONDecoder().decode(AgentsPage.self, from: Data(#"{ "agents": [ { "id": "a" } ] }"#.utf8))
        #expect(old.hiding(libraries: ["studio"]).libraries == nil)
        #expect(old.hiding(libraries: ["studio"]).agents.map(\.id) == ["a"])
    }
}
