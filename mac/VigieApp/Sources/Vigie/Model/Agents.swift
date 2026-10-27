import Foundation

/// GET /api/v2/agents : les recettes livrées avec Vigie (agents/<id>/AGENT.md), le compte sur lequel partira la
/// conversation (celui des nouvelles conversations) et où elle peut s'ouvrir.
struct AgentLibrary: Decodable, Equatable, Sendable {
    @Tolerant var account: AgentAccount?
    @Lossy var agents: [AgentInfo]
    /// Absent : moteur plus ancien, qui prépare le dossier sans rien ouvrir ni joindre de fichiers.
    @Tolerant var surfaces: AgentSurfaces?
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
    /// Ce que l'agent crée (clé `creates` de l'AGENT.md), en phrases courtes.
    @Lossy var creates: [String]
    var error: String?

    var displayName: String {
        if let name, !name.isEmpty { return name }
        return id
    }

    /// Ce que l'agent va créer, sans les lignes vides.
    var willCreate: [String] {
        creates.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }

    /// Le champ où glisser des fichiers : le premier long texte, sinon le premier champ d'adresses.
    var dropField: AgentField? {
        fields.first { $0.kind == .longtext } ?? fields.first { $0.kind.isMultiline }
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
        mcp.filter { $0.isMissing || [.needsAuth, .failed, .pendingApproval, .disabled].contains($0.mcpStatus) }
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
    /// n'est pas saisi, il finit par « / » (le nom viendra là). Sans champ d'une ligne, le nom se tape directement
    /// dans le dossier : il finit par « / » aussi.
    func suggestedFolder(values: [String: String]) -> String {
        let source = namingField.map { values[$0.id] ?? "" } ?? ""
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
/// Un MCP demandé par un agent. Demandé par son service (« figma ») : n'importe quel MCP de ce service fait l'affaire,
/// quel que soit son nom ; `servers` dit lesquels, le mieux connecté d'abord. `status` « missing » : aucun.
struct AgentMCP: Decodable, Equatable, Sendable, Identifiable {
    var name: String
    var status: String?
    var service: String?
    var servers: [String] = []
    /// Le nom à connecter depuis la page Agents (absent : rien à connecter ici, ou par la page MCP).
    var connect: String?

    var id: String { name }
    var mcpStatus: MCPStatus { MCPStatus(raw: status) }
    var isMissing: Bool { status == "missing" }
    /// Le MCP officiel de ce service dans la bibliothèque, pour l'ajouter d'un clic.
    var libraryEntry: MCPLibraryEntry? { service.flatMap { s in MCPLibraryEntry.all.first { $0.id == s } } }
    /// « Figma » plutôt que « figma-pro » : le service compte, pas le nom.
    var title: String { libraryEntry?.title ?? name }

    private enum CodingKeys: String, CodingKey {
        case name, status, service, servers, connect
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
        service = try? container.decodeIfPresent(String.self, forKey: .service)
        servers = ((try? container.decodeIfPresent([String].self, forKey: .servers)) ?? nil) ?? []
        connect = try? container.decodeIfPresent(String.self, forKey: .connect)
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
/// projectFolder) : dans le dossier perso mais pas lui-même, hors des dossiers réservés (Vigie, réglages du Mac et des
/// apps, Claude Code, clés, Codex). Le chemin écrit compte, sans tenir compte des majuscules ni de la façon d'écrire
/// les accents (le disque du Mac ne les distingue pas), et le dossier où il mène aussi, reconnu sur le disque quel que
/// soit le chemin pris (lien, /System/Volumes/Data…). Le moteur reste l'arbitre ; ceci grise le bouton avant le clic.
enum AgentFolderRule {
    typealias Reserved = (name: String, reason: String)

    /// Sous le dossier perso (FORBIDDEN dans lib/agents.mjs), avec la raison affichée, la même que dans le moteur.
    static let reserved: [Reserved] = [
        (".vigie", "dossier de Vigie"),
        ("Library", "réglages du Mac et des apps, iCloud Drive et Dropbox compris"),
        (".claude", "réglages de Claude Code"),
        (".claude-comptes", "comptes Claude Code de Vigie"),
        (".ssh", "tes clés"),
        (".codex", "réglages de Codex"),
    ]
    static let maxLength = 1024
    private static let homeItself = "Dossier refusé : choisis un dossier dans ton dossier perso, pas le dossier perso lui-même."

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
    /// Mêmes refus que le moteur ; phrases parfois plus précises.
    static func issue(_ raw: String, parent: String, home: String = AgentFolderRule.home) -> String? {
        guard !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return "Indique le dossier du projet." }
        let path = expanded(raw, home: home)
        if path.utf16.count > maxLength || path.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }) {
            return "Dossier refusé : chemin trop long ou illisible. Choisis un autre dossier avec « Choisir… »."
        }
        guard path.hasPrefix("/") else { return "Indique un chemin complet, par exemple ~/Code/cabinet-martin." }
        guard within(path, home) else { return "Dossier refusé : il doit être dans ton dossier perso." }
        // le dossier perso d'abord, avec la phrase du moteur, même quand l'agent le propose comme dossier parent (~)
        if same(path, home) { return homeItself }
        if same(path, expanded(parent, home: home)) {
            return "Choisis un dossier rien que pour ce projet, pas \(tilde(path, home: home)) lui-même."
        }
        // le chemin écrit, même là où rien n'est encore créé
        if let bad = reserved.first(where: { within(path, join(home, $0.name)) }) { return reservedIssue(bad) }
        return diskIssue(path, home: home)
    }

    /// Le dossier où mène le chemin, tel que le disque le voit (onDisk dans le moteur). Un lien peut mener au dossier
    /// perso, à un dossier réservé ou dedans sans que le chemin le dise (~/Dropbox vers ~/Library/CloudStorage) : on
    /// part donc du chemin réel et on en remonte les parents. Le chemin réel ne ramène pas tout au chemin habituel
    /// (/System/Volumes/Data/Users/… reste tel quel) : chaque parent est comparé à ces dossiers par son identité sur le
    /// disque. Au dossier perso, on s'arrête : le nom suivant compte aussi, pour un dossier réservé pas encore créé.
    private static func diskIssue(_ path: String, home: String) -> String? {
        guard let homeID = DiskID(home) else { return nil }
        let reservedIDs = reserved.compactMap { entry in DiskID(join(home, entry.name)).map { (entry: entry, id: $0) } }
        let parts = realParts(path)
        for depth in stride(from: parts.count, through: 0, by: -1) {
            guard let id = DiskID("/" + parts.prefix(depth).joined(separator: "/")) else { continue } // pas encore là
            if let hit = reservedIDs.first(where: { $0.id == id }) { return reservedIssue(hit.entry) }
            guard id == homeID else { continue }
            guard depth < parts.count else { return homeItself }
            let next = fold(parts[depth])
            return reserved.first(where: { fold($0.name) == next }).map(reservedIssue)
        }
        return nil
    }

    /// Le chemin réel, en morceaux (realPath dans le moteur) : le plus long début qui existe, résolu par realpath
    /// (liens compris), plus la suite pas encore créée.
    private static func realParts(_ path: String) -> [String] {
        var head = path.split(separator: "/").map(String.init)
        var tail: [String] = []
        while true {
            if let resolved = realpath("/" + head.joined(separator: "/"), nil) {
                defer { free(resolved) }
                return String(cString: resolved).split(separator: "/").map(String.init) + tail
            }
            guard let last = head.popLast() else { return tail }
            tail.insert(last, at: 0)
        }
    }

    private static func reservedIssue(_ entry: Reserved) -> String {
        "Dossier refusé : ~/\(entry.name) est réservé (\(entry.reason)). Choisis un dossier ailleurs, dans ~/Code par exemple."
    }

    /// Un dossier sur le disque (volume et numéro), quel que soit le chemin qui y mène ; nil s'il n'est pas là.
    private struct DiskID: Equatable {
        let device: dev_t
        let inode: ino_t

        init?(_ path: String) {
            var info = stat()
            guard stat(path, &info) == 0 else { return nil }
            device = info.st_dev
            inode = info.st_ino
        }
    }

    /// `path` est `root` ou dedans.
    static func within(_ path: String, _ root: String) -> Bool {
        let path = fold(path), root = fold(root)
        let prefix = root.hasSuffix("/") ? root : root + "/"
        return path.utf8.elementsEqual(root.utf8) || path.utf8.starts(with: prefix.utf8)
    }

    private static func same(_ a: String, _ b: String) -> Bool { fold(a).utf8.elementsEqual(fold(b).utf8) }

    /// Comme le disque du Mac, qui plie les majuscules à la façon d'Unicode et pas seulement en minuscules : « .SSH »
    /// et « .ſſh » (s long) sont « .ssh », « é » s'écrit d'une seule façon.
    static func fold(_ path: String) -> String {
        path.folding(options: .caseInsensitive, locale: nil).precomposedStringWithCanonicalMapping
    }

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
