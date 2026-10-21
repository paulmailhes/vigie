import Foundation

enum ConversationStatus: String, Sendable, CaseIterable {
    case working, idle, waiting, blocked, closed, unknown

    init(raw: String?) {
        switch raw {
        case "busy": self = .working
        case let value?: self = ConversationStatus(rawValue: value) ?? .unknown
        case nil: self = .unknown
        }
    }
}

/// ConversationSummary
struct ConversationSummary: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var title: String?
    var project: String?
    var cwd: String?
    var status: String?
    var running: Bool?
    var accountId: String?
    /// « codex » pour une conversation Codex (OpenAI) ; absent pour Claude Code.
    var agent: String?
    var autoAccept: Bool?
    var autoAcceptOverride: Bool?
    var connectors: String?
    var agentsRunning: Int?
    var workflowsRunning: Int?
    var weekPct: Double?
    @FlexDate var lastActivity: Date?
    var needsYou: Int?
    var headline: String?
    var branch: String?
    @FlexDate var startedAt: Date?
    /// Facultatif : tokens relus si la conversation change de compte.
    var contextTokens: Int?
    /// Bascule de compte demandée, faite au prochain message.
    var pendingAccountId: String?
    /// Ce que Claude Code dit attendre de toi.
    var waitingFor: String?
    /// Cartes de la vue d'ensemble (tour 2, facultatifs).
    @Tolerant var progress: CardProgress?
    @Tolerant var tests: CardTests?
    @Tolerant var accepted: CardAccepted?
    @Tolerant var artifacts: CardArtifacts?
    /// Consommation du moment (tour 3, facultatif).
    @Tolerant var rate: ConversationRate?
    /// Alerte « s'emballe » (tour 3, facultatif ; null si rien).
    @Tolerant var alert: ConversationAlert?
    /// Compte réellement utilisé par le processus (null si fermée).
    @Tolerant var account: ConversationAccount?
    /// Arrêtée pour changer de compte : elle repart sur `to` au prochain message de l'utilisateur dans VS Code.
    @Tolerant var resume: ResumeInfo?

    var state: ConversationStatus { ConversationStatus(raw: status) }
    var isCodex: Bool { agent == "codex" }
    var isOpen: Bool { state != .closed }

    /// Titre court affiché dans les listes : le projet (« Atelier », « Portail · back »), sinon le titre.
    var shortTitle: String {
        if let project, !project.isEmpty { return ProjectName.display(project, cwd: cwd) }
        return title ?? "Conversation"
    }
}

/// Consommation du moment : % de la semaine du compte par heure (10 dernières minutes), tokens par minute,
/// 30 valeurs (une par minute) pour une mini-courbe.
struct ConversationRate: Decodable, Equatable, Sendable {
    var weekPctPerHour: Double?
    var tokensPerMin: Double?
    @Lossy var spark: [Double]
    /// up | flat | down
    var trend: String?
}

/// « S'emballe » : consommation anormale, tests qui échouent en boucle, agent qui se répète.
struct ResumeInfo: Decodable, Equatable, Sendable {
    var to: String?
    @FlexDate var at: Date?
}

/// Compte choisi, compte du processus qui tourne, bascule en attente et derniers lancements.
struct ConversationAccount: Decodable, Equatable, Sendable {
    var chosen: String?
    var running: String?
    var pending: Pending?
    var history: [Launch]?

    struct Pending: Decodable, Equatable, Sendable {
        var to: String?
        @FlexDate var since: Date?
    }

    struct Launch: Decodable, Equatable, Sendable {
        @FlexDate var ts: Date?
        var accountId: String?
        var reason: String?
    }
}

struct ConversationAlert: Decodable, Equatable, Sendable {
    var kind: String?
    @FlexDate var since: Date?
    var reason: String?

    var isRunaway: Bool { kind == nil || kind == "emballe" }
}

/// Avancement du plan, sinon de la liste de tâches : « 23 sur 31 », étape en cours.
struct CardProgress: Decodable, Equatable, Sendable {
    var done: Int?
    var total: Int?
    var label: String?
    var current: String?
}

/// Tests récents : échecs des 2 dernières heures non suivis d'une réussite, tests en cours.
struct CardTests: Decodable, Equatable, Sendable {
    var failedRecent: Int?
    var running: Int?
    var lastOk: Bool?
    @FlexDate var lastTs: Date?
    var lastTitle: String?
    /// Facultatif : où sont les échecs (titre, première ligne d'erreur).
    @Lossy var failures: [CardFailure]
}

struct CardFailure: Decodable, Equatable, Sendable {
    var title: String?
    var line: String?
    var kind: String?
    @FlexDate var ts: Date?
    var by: String?
}

struct CardAccepted: Decodable, Equatable, Sendable {
    var today: Int?
    var sinceSeen: Int?
}

struct CardArtifacts: Decodable, Equatable, Sendable {
    var count: Int?
    @Tolerant var last: CardArtifact?
}

struct CardArtifact: Decodable, Equatable, Sendable {
    var title: String?
    var url: String?
    @FlexDate var ts: Date?
}

enum ProjectName {
    /// Dossiers trop génériques pour nommer un projet seuls : on les préfixe du dossier parent.
    private static let generic: Set<String> = [
        "back", "front", "backend", "frontend", "web", "app", "api", "server", "client", "mobile", "site", "www", "src",
    ]

    /// « atelier » → « Atelier », « auto-accept » → « Auto-accept »,
    /// « back » dans …/portail/back → « Portail · back ».
    static func display(_ raw: String, cwd: String? = nil) -> String {
        let name = raw.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return raw }
        if generic.contains(name.lowercased()), let cwd {
            var parent = ((cwd as NSString).deletingLastPathComponent as NSString).lastPathComponent
            if parent.lowercased().hasSuffix("-" + name.lowercased()) {
                parent = String(parent.dropLast(name.count + 1))
            }
            if !parent.isEmpty, parent != "Code", parent != "/" {
                return "\(readable(parent)) · \(name)"
            }
        }
        return readable(name)
    }

    /// Majuscule initiale et espace avant un numéro final (« portail » → « Portail »).
    private static func readable(_ word: String) -> String {
        var result = ""
        var previous: Character?
        for character in word {
            if let previous, previous.isLetter, character.isNumber { result.append(" ") }
            result.append(character)
            previous = character
        }
        return result.prefix(1).uppercased() + result.dropFirst()
    }
}
