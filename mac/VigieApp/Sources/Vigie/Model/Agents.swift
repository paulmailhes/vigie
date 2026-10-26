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

/// Le dossier d'un projet, vérifié dans la feuille comme le moteur le vérifiera au lancement (lib/agents.mjs,
/// projectFolder) : dans le dossier perso mais pas lui-même, hors des dossiers de Vigie, du Mac, de Claude Code et des
/// clés. Le chemin écrit et son chemin réel (liens résolus) comptent tous les deux, sans tenir compte des majuscules
/// ni de la façon d'écrire les accents : le disque du Mac ne les distingue pas. Le moteur reste l'arbitre ; ceci grise
/// le bouton avant le clic.
enum AgentFolderRule {
    /// Sous le dossier perso (FORBIDDEN dans lib/agents.mjs).
    static let reserved = [".vigie", "Library", ".claude", ".claude-comptes", ".ssh", ".codex"]
    static let maxLength = 1024

    static var home: String {
        var home = FileManager.default.homeDirectoryForCurrentUser.path(percentEncoded: false)
        while home.count > 1 && home.hasSuffix("/") { home.removeLast() }
        return home
    }

    /// « ~/Code/x/ » → « /Users/alex/Code/x » : ~ développé, « . », « .. » et « / » en trop retirés, sans lire le
    /// disque (comme path.resolve dans le moteur). Un chemin incomplet reste tel quel.
    static func expanded(_ raw: String, home: String = AgentFolderRule.home) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let given = trimmed == "~" ? home : trimmed.hasPrefix("~/") ? home + trimmed.dropFirst() : trimmed
        guard given.hasPrefix("/") else { return given }
        var parts: [Substring] = []
        for part in given.split(separator: "/") where part != "." {
            if part == ".." { _ = parts.popLast() } else { parts.append(part) }
        }
        return "/" + parts.joined(separator: "/")
    }

    /// Ce qui empêche de lancer côté dossier ; nil : rien. `parent` : le dossier parent proposé par l'agent.
    /// Les phrases du moteur, quand il refuserait la même chose.
    static func issue(_ raw: String, parent: String, home: String = AgentFolderRule.home) -> String? {
        guard !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return "Indique le dossier du projet." }
        let path = expanded(raw, home: home)
        if path.utf16.count > maxLength || path.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }) {
            return "Dossier refusé : chemin trop long ou illisible."
        }
        guard path.hasPrefix("/") else { return "Indique un chemin complet, par exemple ~/Code/cabinet-martin." }
        guard within(path, home) else { return "Dossier refusé : il doit être dans ton dossier perso." }
        if same(path, home) || same(path, expanded(parent, home: home)) {
            return "Choisis un dossier rien que pour ce projet, pas \(tilde(path, home: home)) lui-même."
        }
        let realHome = realPath(home)
        let real = realPath(path)
        if same(real, realHome) {
            return "Dossier refusé : choisis un dossier dans ton dossier perso, pas le dossier perso lui-même."
        }
        let bad = reserved.first { name in
            [join(home, name), join(realHome, name), realPath(join(home, name))]
                .contains { within(path, $0) || within(real, $0) }
        }
        if let bad { return "Dossier refusé : ~/\(bad) est réservé (Vigie, réglages du Mac, Claude Code ou clés)." }
        return nil
    }

    /// Chemin réel : le plus proche parent existant, résolu (liens compris, avec la casse du disque), plus la suite
    /// qui n'existe pas encore.
    static func realPath(_ path: String) -> String {
        var tail: [String] = []
        var current = path
        while true {
            if let resolved = realpath(current, nil) {
                defer { free(resolved) }
                return tail.reversed().reduce(String(cString: resolved), join)
            }
            let up = (current as NSString).deletingLastPathComponent
            guard !up.isEmpty, up != current else { return path }
            tail.append((current as NSString).lastPathComponent)
            current = up
        }
    }

    /// `path` est `root` ou dedans.
    static func within(_ path: String, _ root: String) -> Bool {
        let path = fold(path), root = fold(root)
        let prefix = root.hasSuffix("/") ? root : root + "/"
        return path.utf8.elementsEqual(root.utf8) || path.utf8.starts(with: prefix.utf8)
    }

    private static func same(_ a: String, _ b: String) -> Bool { fold(a).utf8.elementsEqual(fold(b).utf8) }

    /// Comme le disque du Mac : « .SSH » est « .ssh », « é » s'écrit d'une seule façon.
    private static func fold(_ path: String) -> String { path.lowercased().precomposedStringWithCanonicalMapping }

    private static func join(_ base: String, _ name: String) -> String {
        base.hasSuffix("/") ? base + name : base + "/" + name
    }

    /// « /Users/alex/Code » → « ~/Code », pour les phrases.
    private static func tilde(_ path: String, home: String) -> String {
        guard within(path, home) else { return path }
        let rest = (path as NSString).pathComponents.dropFirst((home as NSString).pathComponents.count)
        return rest.isEmpty ? "~" : "~/" + rest.joined(separator: "/")
    }
}

/// Ce qu'a donné « Lancer dans VS Code ».
enum AgentLaunchOutcome: Equatable, Sendable {
    /// VS Code s'ouvre sur le dossier : la feuille se ferme et le toast le dit. `link` : Claude Code dans VS Code, à
    /// ouvrir juste après avec le message préparé (`prompt`, à copier si ce lien ne s'ouvre pas).
    case opened(message: String, link: URL?, prompt: String)
    /// Rien n'est lancé (VS Code absent, refus du moteur) : la phrase s'affiche dans la feuille, qui reste ouverte.
    case refused(String)
    /// Le dossier est prêt mais VS Code ne s'est pas ouvert : la feuille le dit et propose de copier le message.
    case notOpened(prompt: String)
}

/// Les étapes du lancement, avec le moteur et les gestes vers le Mac en paramètres (pour les essais).
@MainActor
enum AgentLaunch {
    // dans la feuille
    static let noVSCodeMessage = "VS Code n'est pas sur ton Mac : rien n'a été créé. Installe-le avec l'extension Claude Code, puis relance l'agent."
    static let notOpenedMessage = "VS Code ne s'est pas ouvert. Le dossier est prêt : copie le message et envoie-le dans Claude Code."
    // dans le toast, une fois la feuille fermée
    static let openedMessage = "Dossier prêt : VS Code s'ouvre, envoie le message préparé pour lancer l'agent"
    static let linkFailedMessage = "Claude Code ne s'est pas ouvert dans VS Code : le message est copié, colle-le dans Claude Code et envoie-le"

    /// VS Code d'abord (sans lui, le moteur n'est pas appelé : rien n'est créé), puis le moteur prépare le dossier,
    /// puis VS Code s'ouvre dessus.
    static func run(hasVSCode: Bool, folder: String,
                    prepare: () async -> Result<WriteResult, ClientError>,
                    openFolder: (String) -> Bool) async -> AgentLaunchOutcome {
        guard hasVSCode else { return .refused(noVSCodeMessage) }
        let result: WriteResult
        switch await prepare() {
        case .success(let prepared): result = prepared
        case .failure(let error): return .refused(error.message)
        }
        let target = result.folder ?? folder
        let prompt = result.prompt ?? result.briefFile.map { "Lis le fichier \($0) et suis ses consignes." }
            ?? "Lis la consigne rangée dans \(target)/.vigie et suis-la."
        guard openFolder(target) else { return .notOpened(prompt: prompt) }
        // seulement l'adresse de Claude Code dans VS Code : rien d'autre ne s'ouvre d'ici
        let link = result.openUrl.flatMap(URL.init(string:)).flatMap { $0.scheme == "vscode" ? $0 : nil }
        return .opened(message: result.message ?? openedMessage, link: link, prompt: prompt)
    }
}
