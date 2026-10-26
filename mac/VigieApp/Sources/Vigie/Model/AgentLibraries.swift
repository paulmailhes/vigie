import Foundation

// MARK: D'où vient un agent

/// GET /api/v2/agents, `source` de chaque agent : `{ kind: "local" }` (le dossier des agents) ou
/// `{ kind: "library", id, name }` (une bibliothèque). Absent, illisible ou d'un autre genre : local.
struct AgentSource: Decodable, Equatable, Sendable {
    /// La bibliothèque d'où vient l'agent ; nil : agent local.
    var libraryID: String?
    var libraryName: String?

    var isLibrary: Bool { libraryID != nil }

    private enum CodingKeys: String, CodingKey {
        case kind, id, name
    }

    init(from decoder: any Decoder) throws {
        guard let container = try? decoder.container(keyedBy: CodingKeys.self),
              (try? container.decodeIfPresent(String.self, forKey: .kind)) == "library" else { return }
        let id = Self.text(container, .id)
        let name = Self.text(container, .name)
        libraryID = id ?? name
        libraryName = name ?? id
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

// MARK: L'adresse du dépôt

/// L'adresse d'un dépôt, vérifiée dans la feuille avant l'envoi, avec les mêmes refus que le moteur pour ce qui se
/// voit à l'écriture (pas de file://, de chemin, de http://, d'identifiant…). Le moteur reste l'arbitre (hôte
/// privé, dépôt introuvable) ; ceci grise « Ajouter » et dit tout de suite ce qui ne va pas.
enum AgentLibraryAddress {
    static let maxLength = 2048
    static let example = "https://github.com/studio/agents"
    static let refused = "Adresse refusée : colle l'adresse du dépôt (https://github.com/… ou git@github.com:…)."
    static let credentials = "Adresse refusée : n'écris pas d'identifiant dans l'adresse, git utilise ceux de ton Mac."
    static let plainHTTP = "Adresse refusée : elle doit commencer par https:// (ou git@ pour une clé SSH)."

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
