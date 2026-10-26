import Foundation

/// GET /api/v2/agents : les recettes rangées dans le dossier des agents (<dossier>/<id>/AGENT.md), et le compte sur
/// lequel partira la conversation (celui des nouvelles conversations).
struct AgentLibrary: Decodable, Equatable, Sendable {
    var dir: String?
    @Tolerant var account: AgentAccount?
    @Lossy var agents: [AgentInfo]
}

struct AgentAccount: Decodable, Equatable, Sendable {
    var id: String?
    var label: String?

    var displayName: String? { label ?? id }
}

/// Un agent : son formulaire, ses MCP nécessaires et leur état. Un AGENT.md illisible arrive avec `error` :
/// l'agent est listé, mais pas lançable.
struct AgentInfo: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var name: String?
    var description: String?
    /// Nom de symbole SF ; inconnu ou absent : la baguette.
    var icon: String?
    /// Dossier parent proposé pour le projet (~ déjà développé par le moteur).
    var folder: String?
    @Lossy var fields: [AgentField]
    @Lossy var mcp: [AgentMCP]
    var error: String?

    var displayName: String {
        if let name, !name.isEmpty { return name }
        return id
    }

    /// La phrase du moteur quand l'AGENT.md est illisible (rien à lancer alors).
    var problem: String? {
        guard let error, !error.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return error
    }

    var canLaunch: Bool { problem == nil }

    /// Les MCP nécessaires à régler avant de lancer (à connecter, en échec, à approuver, coupés). Pas encore vérifié
    /// n'en fait pas partie : il marche peut-être.
    var mcpToFix: [AgentMCP] {
        mcp.filter { [.needsAuth, .failed, .pendingApproval, .disabled].contains($0.mcpStatus) }
    }

    /// Dossier parent des projets de cet agent (~/Code si l'AGENT.md n'en dit rien).
    var parentFolder: String {
        guard var folder, !folder.isEmpty else { return "~/Code" }
        while folder.count > 1 && folder.hasSuffix("/") { folder.removeLast() }
        return folder
    }

    /// Le champ qui nomme le dossier du projet : le premier champ obligatoire d'une ligne, sinon le premier d'une ligne.
    var namingField: AgentField? {
        fields.first { $0.kind == .text && $0.required } ?? fields.first { $0.kind == .text }
    }

    /// Dossier du projet proposé : <dossier parent>/<nom du client en minuscules, sans accents>. Tant que le nom
    /// n'est pas saisi, il finit par « / » (le nom viendra là). Sans champ d'une ligne : le nom de l'agent.
    func suggestedFolder(values: [String: String]) -> String {
        let source = namingField.map { values[$0.id] ?? "" } ?? id
        return parentFolder + (parentFolder.hasSuffix("/") ? "" : "/") + AgentSlug.make(source)
    }
}

/// Un champ du formulaire de lancement.
struct AgentField: Decodable, Equatable, Sendable, Identifiable {
    /// text : une ligne ; longtext : un long texte ; url : une adresse ; urls : une adresse par ligne.
    /// Un type inconnu se remplit comme une ligne de texte.
    enum Kind: String, Sendable {
        case text, longtext, url, urls

        init(raw: String?) { self = raw.flatMap { Kind(rawValue: $0.lowercased()) } ?? .text }

        var isMultiline: Bool { self == .longtext || self == .urls }
    }

    var id: String
    var label: String
    var kind: Kind
    var required: Bool
    var help: String?
    var placeholder: String?

    private enum CodingKeys: String, CodingKey {
        case id, label, type, required, help, placeholder
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = Self.text(container, .label) ?? id
        kind = Kind(raw: try? container.decodeIfPresent(String.self, forKey: .type))
        required = (try? container.decodeIfPresent(Bool.self, forKey: .required)) ?? false
        help = Self.text(container, .help)
        placeholder = Self.text(container, .placeholder)
    }

    /// Texte facultatif : absent, vide ou d'un autre type = nil.
    private static func text(_ container: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> String? {
        guard let value = try? container.decodeIfPresent(String.self, forKey: key), !value.isEmpty else { return nil }
        return value
    }
}

/// Un MCP nécessaire à l'agent et son état (le même que sur la page MCP). Un simple nom est accepté aussi.
struct AgentMCP: Decodable, Equatable, Sendable, Identifiable {
    var name: String
    var status: String?

    var id: String { name }
    var mcpStatus: MCPStatus { MCPStatus(raw: status) }

    private enum CodingKeys: String, CodingKey {
        case name, status
    }

    init(from decoder: any Decoder) throws {
        if let single = try? decoder.singleValueContainer(), let name = try? single.decode(String.self) {
            self.name = name
            status = nil
            return
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        status = try? container.decodeIfPresent(String.self, forKey: .status)
    }
}

/// Nom de dossier tiré d'un texte : « Cabinet Martin & Fils » → « cabinet-martin-fils ».
enum AgentSlug {
    static let maxLength = 60

    /// Minuscules, accents retirés (œ → oe), tout le reste (espaces, ponctuation) en tirets, 60 caractères au plus.
    static func make(_ text: String) -> String {
        let latin = text.applyingTransform(StringTransform("Any-Latin; Latin-ASCII"), reverse: false) ?? text
        var slug = ""
        for character in latin.lowercased() {
            if character.isASCII && (character.isLetter || character.isNumber) {
                slug.append(character)
            } else if !slug.isEmpty && !slug.hasSuffix("-") {
                slug.append("-")
            }
        }
        slug = String(slug.prefix(maxLength))
        while slug.hasSuffix("-") { slug.removeLast() }
        return slug
    }
}
