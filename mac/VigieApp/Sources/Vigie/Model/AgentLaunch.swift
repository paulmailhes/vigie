import Foundation

// MARK: Où s'ouvre l'agent

/// Où s'ouvre la conversation de l'agent : Claude Code dans VS Code, ou l'app Claude.
enum AgentSurface: String, CaseIterable, Identifiable, Sendable {
    case vscode
    case claudeApp = "claude-app"

    var id: String { rawValue }

    /// Dans une phrase : « dans VS Code », « dans l'app Claude ».
    var label: String {
        switch self {
        case .vscode: "VS Code"
        case .claudeApp: "l'app Claude"
        }
    }

    /// Sur le bouton de choix.
    var choice: String {
        switch self {
        case .vscode: "VS Code"
        case .claudeApp: "App Claude"
        }
    }
}

/// GET /api/v2/agents, `surfaces` : ce qui est installé sur ton Mac, et le dernier choix.
struct AgentSurfaces: Decodable, Equatable, Sendable {
    /// Dans l'ordre du moteur ; une valeur inconnue (moteur plus récent) est ignorée.
    var available: [AgentSurface]
    var chosen: AgentSurface?

    private enum CodingKeys: String, CodingKey {
        case available, chosen
    }

    init(available: [AgentSurface], chosen: AgentSurface? = nil) {
        self.available = available
        self.chosen = chosen
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        var list: [AgentSurface] = []
        for raw in try container.decode(Lossy<String>.self, forKey: .available).wrappedValue {
            if let surface = AgentSurface(rawValue: raw), !list.contains(surface) { list.append(surface) }
        }
        available = list
        chosen = (try? container.decodeIfPresent(String.self, forKey: .chosen)).flatMap(AgentSurface.init(rawValue:))
    }

    /// Le choix proposé : le dernier utilisé s'il est encore là, sinon le premier ; nil : rien d'installé.
    var preferred: AgentSurface? {
        if let chosen, available.contains(chosen) { return chosen }
        return available.first
    }
}

// MARK: Le dossier du projet

/// GET /api/v2/agents/folder?path=… : ce que le moteur sait du dossier choisi, montré sous le champ.
struct AgentFolderInfo: Decodable, Equatable, Sendable {
    /// Le moteur en liste 50 au plus.
    static let maxSources = 50

    var path: String?
    var exists: Bool
    /// La raison du refus du dossier (la même qu'au lancement) ; le reste est alors vide.
    var error: String?
    /// Les conversations Claude Code de ce dossier, la plus récente d'abord.
    var conversations: [AgentConversation]
    /// Les noms dans <dossier>/sources/.
    var sources: [String]

    private enum CodingKeys: String, CodingKey {
        case path, exists, error, conversations, sources
    }

    init(path: String? = nil, exists: Bool, error: String? = nil, conversations: [AgentConversation] = [], sources: [String] = []) {
        self.path = path
        self.exists = exists
        self.error = error
        self.conversations = conversations
        self.sources = sources
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        path = try? container.decodeIfPresent(String.self, forKey: .path)
        exists = (try? container.decodeIfPresent(Bool.self, forKey: .exists)) ?? false
        error = try? container.decodeIfPresent(String.self, forKey: .error)
        conversations = try container.decode(Lossy<AgentConversation>.self, forKey: .conversations).wrappedValue
        sources = try container.decode(Lossy<String>.self, forKey: .sources).wrappedValue
    }

    /// L'adresse de la lecture : le chemin entier dans `path`, « & », « + » et « # » compris.
    static func route(_ path: String) -> String {
        "/api/v2/agents/folder?path=" + (path.addingPercentEncoding(withAllowedCharacters: queryValue) ?? path)
    }

    private static let queryValue: CharacterSet = {
        var set = CharacterSet.urlQueryAllowed
        set.remove(charactersIn: "&=+#?")
        return set
    }()

    /// La phrase du moteur quand il refuse ce dossier.
    var problem: String? {
        guard let error, !error.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return error
    }

    /// Les conversations à proposer de continuer (aucune si le dossier est refusé).
    var resumable: [AgentConversation] { problem == nil ? conversations : [] }

    /// La légende sous le dossier : nouveau, existant (et ce qu'il y a dans sources/), ou la raison du refus.
    var note: (text: String, warn: Bool) {
        if let problem { return (problem, true) }
        guard exists else { return ("Nouveau dossier : Vigie le crée.", false) }
        let count = sources.count
        guard count > 0 else { return ("Dossier existant : Vigie y range la consigne de l'agent.", false) }
        let files = count >= Self.maxSources ? "\(count) fichiers ou plus" : Fmt.count(count, "fichier")
        return ("Dossier existant · \(files) dans sources/", false)
    }
}

/// Une conversation Claude Code déjà dans le dossier du projet.
struct AgentConversation: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var title: String?
    var lastActivity: Date?
    /// Vivante en ce moment.
    var running: Bool
    /// vscode, claude-app ou terminal.
    var surface: String?

    private enum CodingKeys: String, CodingKey {
        case id, title, lastActivity, running, surface
    }

    init(id: String, title: String? = nil, lastActivity: Date? = nil, running: Bool = false, surface: String? = nil) {
        self.id = id
        self.title = title
        self.lastActivity = lastActivity
        self.running = running
        self.surface = surface
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = (try? container.decodeIfPresent(String.self, forKey: .title)).flatMap { $0.isEmpty ? nil : $0 }
        lastActivity = try container.decode(FlexDate.self, forKey: .lastActivity).wrappedValue
        running = (try? container.decodeIfPresent(Bool.self, forKey: .running)) ?? false
        surface = try? container.decodeIfPresent(String.self, forKey: .surface)
    }

    /// Là où elle vit : « VS Code », « l'app Claude », « Terminal » ; nil si inconnu.
    var place: String? {
        switch surface {
        case "vscode": "VS Code"
        case "claude-app": "l'app Claude"
        case "terminal": "Terminal"
        default: nil
        }
    }

    /// « « Brief et références » · il y a 2 h · VS Code (en cours) ».
    func summary(now: Date) -> String {
        var parts = [title.map { "« \($0) »" } ?? "Conversation sans titre"]
        if let lastActivity { parts.append(Fmt.ago(lastActivity, now: now)) }
        if let place {
            parts.append(running ? "\(place) (en cours)" : place)
        } else if running {
            parts.append("en cours")
        }
        return parts.joined(separator: " · ")
    }
}

// MARK: Fichiers joints

/// Un fichier (ou un dossier) joint au lancement : le moteur le copie dans sources/ du projet.
struct AgentAttachment: Equatable, Sendable, Identifiable {
    /// Chemin absolu, tel qu'il part au moteur.
    var path: String
    /// En octets ; nil pour un dossier.
    var size: Int64?
    var isFolder: Bool
    /// Copie faite par Vigie dans son dossier temporaire (fichier promis par Mail ou Safari, fichier de ~/Library).
    var isCopy: Bool

    var id: String { path }
    var name: String { (path as NSString).lastPathComponent }

    /// « 248 Ko », « Dossier ».
    var detail: String {
        if isFolder { return "Dossier" }
        return size.map { $0.formatted(.byteCount(style: .file).locale(Fmt.locale)) } ?? ""
    }

    /// Lu sur le disque ; nil s'il n'y est pas.
    static func read(_ url: URL, isCopy: Bool = false) -> AgentAttachment? {
        let path = url.path(percentEncoded: false)
        var isFolder: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isFolder) else { return nil }
        let size = isFolder.boolValue ? nil : (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize.map(Int64.init)
        return AgentAttachment(path: path, size: size, isFolder: isFolder.boolValue, isCopy: isCopy)
    }

    /// Un fichier de ~/Library (iCloud Drive, Dropbox, téléchargements de Mail) : le moteur refuse ce dossier réservé,
    /// Vigie en fait donc une copie à lui, tout de suite. Pas un dossier entier : il peut être énorme.
    static func needsCopy(_ path: String, isFolder: Bool, home: String = AgentFolderRule.home) -> Bool {
        !isFolder && AgentFolderRule.within(path, home + "/Library")
    }
}

/// Les fichiers joints de la feuille, sans doublon, 50 au plus (la limite du moteur).
struct AgentAttachments: Equatable, Sendable {
    static let maxCount = 50
    static let tooMany = "50 fichiers joints au plus : range les autres dans un dossier, et joins ce dossier."

    private(set) var items: [AgentAttachment] = []

    init(_ items: [AgentAttachment] = []) {
        add(items)
    }

    var isEmpty: Bool { items.isEmpty }
    var paths: [String] { items.map(\.path) }

    /// Ajoute ce qui n'y est pas déjà. Au-delà de 50, rien de plus : la phrase renvoyée le dit (nil : tout est là).
    @discardableResult
    mutating func add(_ new: [AgentAttachment]) -> String? {
        for item in new {
            let key = Self.key(item)
            if items.contains(where: { Self.key($0) == key }) { continue }
            guard items.count < Self.maxCount else { return Self.tooMany }
            items.append(item)
        }
        return nil
    }

    /// Retire un fichier joint ; renvoie celui retiré (sa copie, s'il en a une, est à effacer).
    @discardableResult
    mutating func remove(_ id: AgentAttachment.ID) -> AgentAttachment? {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return nil }
        return items.remove(at: index)
    }

    /// Même chemin, sans tenir compte des majuscules (comme le disque). Une copie de Vigie change de chemin à chaque
    /// dépôt : même nom et même taille, c'est la même pièce jointe déposée deux fois.
    private static func key(_ item: AgentAttachment) -> String {
        item.isCopy ? "copie:\(AgentFolderRule.fold(item.name)):\(item.size ?? -1)" : AgentFolderRule.fold(item.path)
    }
}

// MARK: Lancement

/// Ce que le moteur a ouvert (réponse du lancement, `opened`).
enum AgentOpened: String, Sendable {
    /// VS Code ou l'app Claude, avec le message prérempli.
    case full
    /// VS Code ouvert sur le dossier, mais Claude Code n'a pas répondu à temps : pas de message.
    case folder
    /// La conversation rouverte dans l'app Claude, qui ne prend pas de message.
    case noPrompt = "no-prompt"
    /// Rien ne s'est ouvert.
    case nothing = "none"
}

/// Ce qu'a donné « Lancer ».
enum AgentLaunchOutcome: Equatable, Sendable {
    /// Le moteur a préparé le dossier, et ouvert ce qu'il a pu : la feuille se ferme, le toast dit la suite. `copy` :
    /// le message à mettre dans le presse-papiers (il n'a pas pu être prérempli) ; `alert` : rien ne s'est ouvert.
    case launched(message: String, copy: String?, alert: Bool)
    /// Rien n'est lancé (refus du moteur, moteur injoignable) : la phrase s'affiche dans la feuille, qui reste ouverte.
    case refused(String)
}

/// Les étapes du lancement, sans l'écran ni le réseau (pour les essais). C'est le moteur qui ouvre VS Code ou l'app
/// Claude, une fois la fenêtre du projet prête : l'app n'ouvre plus rien.
enum AgentLaunch {
    /// Moteur plus ancien (pas de `opened`) : il prépare le dossier, n'ouvre rien et ne copie pas de fichiers.
    static let legacyMessage = "Dossier prêt, message copié : ouvre le dossier dans VS Code et colle le message dans Claude Code. Mets Vigie à jour pour que l'agent s'ouvre tout seul."
    static let legacyFilesMessage = "Ce moteur de Vigie ne sait pas encore joindre des fichiers : mets Vigie à jour (Réglages › Mises à jour), ou retire-les."
    static let noSurfaceMessage = "Ni VS Code (avec l'extension Claude Code) ni l'app Claude ne sont sur ton Mac : installe l'un des deux pour lancer un agent."

    /// « Lancer dans VS Code », « Continuer dans l'app Claude » ; « Lancer » avec un moteur plus ancien.
    static func buttonTitle(surface: AgentSurface?, continuing: Bool) -> String {
        let verb = continuing ? "Continuer" : "Lancer"
        guard let surface else { return verb }
        return "\(verb) dans \(surface.label)"
    }

    /// La conversation à continuer : celle choisie, si elle est encore dans ce dossier ; nil : nouvelle conversation.
    static func session(_ info: AgentFolderInfo?, pick: String?, startNew: Bool) -> String? {
        guard !startNew, let list = info?.resumable, !list.isEmpty else { return nil }
        if let pick, list.contains(where: { $0.id == pick }) { return pick }
        return list.first?.id
    }

    /// POST /api/v2/agents/launch : `files`, `surface` et `session` seulement s'il y a quelque chose à dire.
    static func body(agent: String, values: [String: String], folder: String, files: [String],
                     surface: AgentSurface?, session: String?) -> JSONValue {
        var body: [String: JSONValue] = ["id": .string(agent), "values": .object(values.mapValues(JSONValue.string)),
                                         "folder": .string(folder)]
        if !files.isEmpty { body["files"] = .array(files.map(JSONValue.string)) }
        if let surface { body["surface"] = .string(surface.rawValue) }
        if let session { body["session"] = .string(session) }
        return .object(body)
    }

    /// La réponse du moteur, traduite pour la feuille : refus, ou lancé (avec le message à copier quand il n'a pas pu
    /// être prérempli).
    static func outcome(_ answer: Result<WriteResult, ClientError>, surface: AgentSurface?) -> AgentLaunchOutcome {
        let result: WriteResult
        switch answer {
        case .success(let launched): result = launched
        case .failure(let error): return .refused(error.message)
        }
        let prompt = result.prompt ?? result.briefFile.map { "Lis le fichier \($0) et suis ses consignes." }
            ?? result.folder.map { "Lis la consigne rangée dans \($0)/.vigie et suis-la." }
            ?? "Lis la consigne rangée dans le dossier .vigie du projet et suis-la."
        // moteur plus ancien : sa phrase dit que VS Code s'ouvre, c'était l'app qui le faisait
        guard let raw = result.opened else { return .launched(message: legacyMessage, copy: prompt, alert: false) }
        let opened = AgentOpened(rawValue: raw)
        let said = result.message.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        let message = said ?? Self.message(opened ?? .nothing, surface: result.surface.flatMap(AgentSurface.init(rawValue:)) ?? surface)
        switch opened {
        case .full: return .launched(message: message, copy: nil, alert: false)
        case .nothing: return .launched(message: message, copy: prompt, alert: true)
        case .folder, .noPrompt, nil: return .launched(message: message, copy: prompt, alert: false)
        }
    }

    /// Les phrases du moteur, si sa réponse n'en a pas.
    static func message(_ opened: AgentOpened, surface: AgentSurface?) -> String {
        switch (opened, surface) {
        case (.full, .claudeApp): "L'app Claude s'ouvre sur le projet, avec le message prêt : envoie-le."
        case (.full, _): "VS Code s'ouvre sur le projet, avec le message prêt dans Claude Code : envoie-le."
        case (.folder, _): "VS Code est ouvert sur le projet, mais Claude Code n'a pas répondu à temps : le message est copié, colle-le dans Claude Code et envoie-le."
        case (.noPrompt, _): "La conversation s'ouvre dans l'app Claude : le message est copié, colle-le (⌘V) et envoie-le."
        case (.nothing, _): "Le dossier est prêt, mais rien ne s'est ouvert : le message est copié, colle-le dans Claude Code."
        }
    }
}

/// La lecture du dossier par le moteur, à chaque changement : 400 ms après la dernière frappe, annulée si le dossier
/// change encore ou si la feuille se ferme (rien ne tourne en fond).
@MainActor
enum AgentFolderCheck {
    static let pause: Duration = .milliseconds(400)

    /// Attend `pause`, puis lit ; annulée pendant l'attente : rien n'est lu, nil.
    static func afterPause<Value>(_ pause: Duration,
                                  sleep: (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
                                  read: () async -> Value?) async -> Value? {
        if pause > .zero {
            do { try await sleep(pause) } catch { return nil }
        }
        guard !Task.isCancelled else { return nil }
        return await read()
    }
}
