import Foundation

// MARK: D'où vient un agent

/// GET /api/v2/agents, `source` de chaque agent : `{ kind: "local" }` (le dossier des agents) ou
/// `{ kind: "library", id, name }` (une bibliothèque, `name` : « propriétaire/dépôt »). Absent, illisible ou d'un
/// autre genre : affiché comme local. Renvoyé tel quel au lancement (`launchValue`) : le moteur refuse si l'agent de
/// cet id vient d'ailleurs depuis l'ouverture du formulaire (bibliothèque retirée, conflit de noms).
struct AgentSource: Decodable, Equatable, Sendable {
    /// Le genre dit par le moteur : « local », « library », ou un genre qu'il ajouterait plus tard.
    var kind = "local"
    /// L'id tel que le moteur l'a donné (la bibliothèque, pour « library »).
    var id: String?
    /// La bibliothèque d'où vient l'agent ; nil : agent local.
    var libraryID: String?
    var libraryName: String?

    var isLibrary: Bool { libraryID != nil }

    private enum CodingKeys: String, CodingKey {
        case kind, id, name
    }

    init(kind: String = "local", id: String? = nil, name: String? = nil) {
        self.kind = kind
        self.id = id
        guard kind == "library" else { return }
        libraryID = id ?? name
        libraryName = name ?? id
    }

    init(from decoder: any Decoder) throws {
        guard let container = try? decoder.container(keyedBy: CodingKeys.self),
              let kind = Self.text(container, .kind) else {
            self.init()
            return
        }
        self.init(kind: kind, id: Self.text(container, .id), name: Self.text(container, .name))
    }

    /// `source` du lancement : ce que le formulaire a montré. `{ kind: "local" }`, sinon le genre et l'id du moteur
    /// (`{ kind: "library", id: "<bibliothèque>" }`).
    var launchValue: JSONValue {
        var value: [String: JSONValue] = ["kind": .string(kind)]
        if kind != "local", let id { value["id"] = .string(id) }
        return .object(value)
    }

    private static func text(_ container: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> String? {
        guard let value = (try? container.decodeIfPresent(String.self, forKey: key))?
            .trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }
}

// MARK: Une bibliothèque

/// GET /api/v2/agents, `libraries` : un dépôt git (un dossier par agent) que Vigie récupère et tient à jour toutes
/// les heures. La mise à jour a échoué : la dernière bonne copie sert toujours, l'erreur s'affiche en orange.
struct AgentLibraryInfo: Decodable, Equatable, Sendable, Identifiable {
    enum Status: Equatable, Sendable {
        case ok, updating, error

        /// Absent : selon qu'il y a une erreur ou non. Inconnu (moteur plus récent) : comme une erreur, sans rien
        /// bloquer (les agents restent là, « Mettre à jour » aussi).
        init(raw: String?, hasError: Bool) {
            switch raw?.lowercased() {
            case "ok": self = .ok
            case "updating": self = .updating
            case nil: self = hasError ? .error : .ok
            default: self = .error
            }
        }
    }

    static let route = "/api/v2/agents/libraries"
    /// Erreur sans phrase (ou statut inconnu).
    static let failedUpdate = "La dernière mise à jour n'a pas abouti : clique sur « Mettre à jour » pour réessayer."

    var id: String
    var name: String?
    var url: String?
    var addedAt: Date?
    var updatedAt: Date?
    /// Le commit de la copie (7 caractères).
    var commit: String?
    var status: Status
    var error: String?
    /// Le nombre d'agents ; absent : compté dans la liste.
    var agents: Int?

    private enum CodingKeys: String, CodingKey {
        case id, name, url, addedAt, updatedAt, commit, status, error, agents
    }

    init(id: String, name: String? = nil, url: String? = nil, addedAt: Date? = nil, updatedAt: Date? = nil,
         commit: String? = nil, status: Status = .ok, error: String? = nil, agents: Int? = nil) {
        self.id = id
        self.name = name
        self.url = url
        self.addedAt = addedAt
        self.updatedAt = updatedAt
        self.commit = commit
        self.status = status
        self.error = error
        self.agents = agents
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = Self.text(container, .name)
        url = Self.text(container, .url)
        addedAt = try container.decode(FlexDate.self, forKey: .addedAt).wrappedValue
        updatedAt = try container.decode(FlexDate.self, forKey: .updatedAt).wrappedValue
        commit = Self.text(container, .commit)
        error = Self.text(container, .error)
        status = Status(raw: Self.text(container, .status), hasError: error != nil)
        agents = (try? container.decodeIfPresent(Int.self, forKey: .agents)).map { max(0, $0) }
    }

    /// Texte facultatif : absent, vide, blanc ou d'un autre type = nil.
    private static func text(_ container: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> String? {
        guard let value = try? container.decodeIfPresent(String.self, forKey: key),
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return value
    }

    /// « studio/agents » (propriétaire/dépôt : deux dépôts du même nom restent distincts) ; moteur plus ancien : le
    /// nom du dépôt seul, ou l'id.
    var displayName: String { name ?? id }

    /// « github.com/studio/agents ».
    var shortURL: String? { url.map(AgentLibraryAddress.short) }

    /// Ce qui ne va pas, en orange ; nil : rien (à jour, ou en cours de mise à jour).
    var problem: String? {
        guard status == .error else { return nil }
        return error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? Self.failedUpdate
    }

    /// « Mise à jour il y a 2 h · 3 agents », « Mise à jour en cours… · 1 agent », « Ajoutée il y a 3 j · aucun agent ».
    func summary(now: Date, count: Int) -> String {
        var parts: [String] = []
        if status == .updating {
            parts.append("Mise à jour en cours…")
        } else if let updatedAt {
            parts.append("Mise à jour \(Fmt.ago(updatedAt, now: now))")
        } else if let addedAt {
            parts.append("Ajoutée \(Fmt.ago(addedAt, now: now))")
        }
        parts.append(count > 0 ? Fmt.count(count, "agent") : parts.isEmpty ? "Aucun agent" : "aucun agent")
        return parts.joined(separator: " · ")
    }
}

// MARK: Le nom, à l'écran

/// « propriétaire/dépôt » mis en page sans être coupé bêtement : s'il faut deux lignes, la coupure se fait après « / »,
/// jamais après un trait d'union (« mon-studio » reste entier) ; seul un nom plus long que la ligne se coupe ailleurs.
/// Les caractères ajoutés ne se voient pas (espace sans largeur, gluon de mots).
enum AgentLibraryName {
    static func wrapping(_ name: String) -> String {
        var text = ""
        for character in name {
            text.append(character)
            switch character {
            case "/": text.append("\u{200B}") // coupure permise
            case "-": text.append("\u{2060}") // pas de coupure
            default: break
            }
        }
        return text
    }
}

// MARK: L'ajout

/// Ce qu'a donné « Ajouter ».
enum AgentLibraryAddOutcome: Equatable, Sendable {
    /// Ajoutée : la feuille se ferme, le toast le dit.
    case added
    /// Rien n'est ajouté (refus du moteur, moteur injoignable) : la phrase s'affiche dans la feuille, qui reste ouverte.
    case refused(String)
    /// Pas de réponse dans le délai, et pas encore dans la liste : le moteur continue (gros dépôt, autre bibliothèque
    /// en cours avant elle). La feuille le dit, sans parler de panne.
    case stillRunning
}

/// Les étapes de l'ajout, sans l'écran ni le réseau (pour les essais).
enum AgentLibraryAdd {
    static let added = "Bibliothèque ajoutée."
    static let stillRunning = "Toujours en cours : attends un instant, puis rouvre la page Agents."
    /// Dans la feuille, le bandeau « Relancer » de la fenêtre est caché : la phrase dit où il est.
    static let unreachable = "Le moteur de Vigie ne répond pas : ferme cette fenêtre, clique sur « Relancer » dans le bandeau, puis réessaie."

    /// La réponse du moteur à l'ajout ; nil : délai dépassé, la liste relue dira si la bibliothèque est arrivée
    /// (`afterTimeout`).
    static func outcome(_ answer: Result<WriteResult, ClientError>) -> AgentLibraryAddOutcome? {
        switch answer {
        case .success: .added
        case .failure(.timedOut): nil
        case .failure(.unreachable): .refused(unreachable)
        case .failure(let error): .refused(error.message)
        }
    }

    /// Après un délai dépassé : ajoutée si la liste relue a une bibliothèque de cette adresse, quelle que soit sa forme,
    /// qui n'y était pas avant l'envoi (`before` : les ids d'alors) ; sinon, toujours en cours.
    static func afterTimeout(url: String, before: Set<String>, page: AgentsPage?) -> AgentLibraryAddOutcome {
        let key = AgentLibraryAddress.key(url)
        let arrived = page?.libraries?.contains { library in
            !before.contains(library.id) && library.url.map(AgentLibraryAddress.key) == key
        } ?? false
        return arrived ? .added : .stillRunning
    }
}

// MARK: L'adresse du dépôt

/// L'adresse d'un dépôt, vérifiée dans la feuille avant l'envoi, avec les mêmes refus que le moteur pour ce qui se
/// voit à l'écriture (pas de file://, de chemin, de http://, d'identifiant…). Le moteur reste l'arbitre (hôte
/// privé, dépôt introuvable) ; ceci grise « Ajouter » et dit tout de suite ce qui ne va pas.
enum AgentLibraryAddress {
    static let maxLength = 2048
    static let example = "https://github.com/studio/agents"
    static let refused = "Adresse refusée : colle l'adresse du dépôt (https://github.com/… ou git@github.com:…)."
    static let credentials = "Adresse refusée : retire l'identifiant écrit avant « @ », git utilise ceux de ton Mac."
    static let plainHTTP = "Adresse refusée : remplace http:// par https:// (ou colle l'adresse git@… pour une clé SSH)."
    /// …/tree/main, …/blob/main/AGENT.md, …/-/tree/main (GitLab) : l'adresse d'une page du dépôt, copiée du navigateur.
    static let page = "Adresse refusée : colle l'adresse du dépôt lui-même (https://github.com/<propriétaire>/<dépôt>), pas celle d'une page."

    enum Check: Equatable {
        /// Rien d'écrit.
        case empty
        /// Le début d'une adresse acceptable (« https://github.com ») : rien à dire, « Ajouter » encore grisé.
        case typing
        /// Prête à partir, telle quelle.
        case ready(String)
        /// Refusée, avec la raison.
        case refused(String)
    }

    private static let schemes = ["https://", "ssh://", "git@"]

    /// Sans blancs autour ; « github.com/studio/agents » (copié sans le début) devient « https://github.com/studio/agents ».
    static func normalized(_ raw: String) -> String {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard looksLikeHostAndPath(text), let slash = text.firstIndex(of: "/"),
              text[..<slash].contains("."), text.index(after: slash) < text.endIndex else { return text }
        return "https://" + text
    }

    /// « github.com/studio/agents », ou son début : des lettres, chiffres, « . », « - », « _ » et « / », sans adresse
    /// complète ni chemin (« / » ou « . » en tête).
    private static func looksLikeHostAndPath(_ text: String) -> Bool {
        guard let first = text.unicodeScalars.first, first.isASCII, CharacterSet.alphanumerics.contains(first) else { return false }
        return text.unicodeScalars.allSatisfy { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || "./-_".unicodeScalars.contains($0)) }
    }

    static func check(_ raw: String) -> Check {
        let text = normalized(raw)
        guard !text.isEmpty else { return .empty }
        if text.utf16.count > maxLength || text.hasPrefix("-")
            || text.unicodeScalars.contains(where: { $0.properties.isWhitespace || $0.value < 0x20 || $0.value == 0x7F }) {
            return .refused(refused)
        }
        let lower = text.lowercased()
        // le début d'une adresse acceptable (« htt », « git ») : on attend la suite
        if schemes.contains(where: { $0.hasPrefix(lower) }) { return .typing }
        if lower.hasPrefix("http:") { return .refused(plainHTTP) }
        if lower.hasPrefix("https://") || lower.hasPrefix("ssh://") {
            let rest = text.drop { $0 != "/" }.dropFirst(2) // après « :// »
            let authority = rest.prefix { $0 != "/" }
            if lower.hasPrefix("https://"), authority.contains("@") { return .refused(credentials) }
            let path = rest.dropFirst(authority.count).drop { $0 == "/" }
            if isPage(path) { return .refused(page) }
            return authority.isEmpty || path.isEmpty ? .typing : .ready(text)
        }
        if lower.hasPrefix("git@") {
            let rest = text.dropFirst(4)
            guard let colon = rest.firstIndex(of: ":") else { return .typing }
            let host = rest[..<colon], path = rest[rest.index(after: colon)...]
            if host.isEmpty { return .refused(refused) }
            return path.isEmpty ? .typing : .ready(text)
        }
        // « github.com » sans la suite : le nom du dépôt viendra
        return looksLikeHostAndPath(text) ? .typing : .refused(refused)
    }

    /// Le chemin d'une page du dépôt : « tree » ou « blob » après propriétaire/dépôt (« studio/agents/tree/main »), ou
    /// un élément « - » (GitLab : « groupe/agents/-/tree/main »), que le moteur refuse.
    private static func isPage(_ path: Substring) -> Bool {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        return parts.contains("-") || parts.dropFirst(2).contains { $0 == "tree" || $0 == "blob" }
    }

    /// La même adresse quelle que soit sa forme (https ou git@, « .git », « / » final, majuscules) : pour la
    /// reconnaître dans la liste du moteur.
    static func key(_ url: String) -> String { short(url).lowercased() }

    /// « https://github.com/studio/agents.git » → « github.com/studio/agents » ; « git@github.com:studio/agents.git »
    /// et « ssh://git@github.com/studio/agents » aussi.
    static func short(_ url: String) -> String {
        var text = Substring(url.trimmingCharacters(in: .whitespacesAndNewlines))
        if let scheme = ["https://", "http://", "ssh://"].first(where: { text.lowercased().hasPrefix($0) }) {
            text = text.dropFirst(scheme.count)
            if let at = text.prefix(while: { $0 != "/" }).firstIndex(of: "@") { text = text[text.index(after: at)...] }
        } else if text.lowercased().hasPrefix("git@") {
            text = text.dropFirst(4)
            if let colon = text.firstIndex(of: ":") { text = text[..<colon] + "/" + text[text.index(after: colon)...] }
        }
        while text.hasSuffix("/") { text = text.dropLast() }
        if text.lowercased().hasSuffix(".git") { text = text.dropLast(4) }
        return String(text)
    }

    /// La page du dépôt dans le navigateur : seulement pour une adresse https sans identifiant.
    static func webPage(_ url: String) -> URL? {
        guard url.lowercased().hasPrefix("https://"), var components = URLComponents(string: url),
              components.user == nil, components.host?.isEmpty == false else { return nil }
        if components.path.lowercased().hasSuffix(".git") { components.path = String(components.path.dropLast(4)) }
        return components.url
    }
}
