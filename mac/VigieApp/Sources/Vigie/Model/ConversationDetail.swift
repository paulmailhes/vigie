import Foundation

/// GET /api/v2/conversation/:id
struct ConversationDetail: Decodable, Equatable, Sendable {
    @Tolerant var summary: ConversationSummary?
    @Tolerant var now: NowState?
    @Lossy var chapters: [Chapter]
    @Lossy var accepted: [AcceptedItem]
    @Lossy var activity: [ActivityItem]
    @Tolerant var agents: AgentsState?
    @Lossy var workflows: [Workflow]
    @Lossy var artifacts: [Artifact]
    @Lossy var files: [FileItem]
    @Lossy var tests: [TestRun]
    @Lossy var mcp: [ConversationMCP]
    @Tolerant var tokens: TokenState?
    @Lossy var limits: [LimitHit]
    /// La demande en cours et ce qu'elle a donné depuis.
    @Tolerant var current: CurrentRequest?
    /// Le fil : ce qui compte, du plus récent au plus ancien.
    @Lossy var milestones: [Milestone]
    /// Le document d'état qu'elle tient à jour (ETAT.md…), découpé en sections : sa feuille de route.
    @Tolerant var trackingDoc: TrackingDoc?
    /// Facultatif : tokens relus si la conversation change de compte.
    var contextTokens: Int?
}

struct NowState: Decodable, Equatable, Sendable {
    var text: String?
    @FlexDate var ts: Date?
    /// Dernier message de Claude en plein travail, plus récent que son compte rendu.
    @Tolerant var live: LiveNote?
    @Lossy var tasks: [TaskItem]
    /// Dernière mise à jour de la liste de tâches.
    @FlexDate var tasksTs: Date?
    /// Plan en plusieurs étapes suivi par la conversation.
    @Tolerant var plan: WorkPlan?
}

/// Dernière demande de l'utilisateur, depuis quand, et ce qui en est sorti.
struct CurrentRequest: Decodable, Equatable, Sendable {
    var prompt: String?
    @FlexDate var start: Date?
    var workflows: Int?
    var agents: Int?
    var artifacts: Int?
    var files: Int?
    var commits: Int?
    var pushes: Int?
    var deploys: Int?
    var testsOk: Int?
    var testsFailed: Int?
    /// Relancée depuis par un message court (« continue ») : la demande affichée est la vraie, d'avant.
    @Tolerant var relaunch: Relaunch?

    struct Relaunch: Decodable, Equatable, Sendable {
        var prompt: String?
        @FlexDate var ts: Date?
    }
}

struct TrackingDoc: Decodable, Equatable, Sendable {
    var path: String
    var title: String?
    @FlexDate var updatedAt: Date?
    var edits: Int?
    var intro: String?
    @Lossy var sections: [Section]
    @Lossy var others: [Other]

    struct Section: Decodable, Equatable, Sendable {
        var title: String
        var text: String?
    }

    struct Other: Decodable, Equatable, Sendable {
        var path: String
        @FlexDate var ts: Date?
        var edits: Int?
    }
}

/// Un jalon du fil.
struct Milestone: Decodable, Equatable, Sendable {
    enum Kind: String, Sendable {
        case prompt, report, commit, push, deploy, pr, agent, workflow, tests, artifact, limit, other
    }

    @FlexDate var ts: Date?
    var kind: String?
    var title: String?
    var detail: String?
    var by: String?
    var ok: Bool?
    var url: String?

    var milestoneKind: Kind { kind.flatMap(Kind.init(rawValue:)) ?? .other }
}

struct LiveNote: Decodable, Equatable, Sendable {
    var text: String?
    @FlexDate var ts: Date?
}

/// Un plan en plusieurs étapes (fichier de plan écrit ou lu par la conversation).
struct WorkPlan: Decodable, Equatable, Sendable {
    var title: String?
    var file: String?
    @FlexDate var updatedAt: Date?
    @Lossy var steps: [PlanStep]
    var done: Int?
    var total: Int?
    /// Étape en cours (première non faite).
    var current: String?

    var doneCount: Int { done ?? steps.count(where: { $0.state == .done }) }
    var totalCount: Int { max(total ?? steps.count, doneCount) }

    /// L'étape en cours : celle que le moteur désigne, sinon la première en cours, sinon la première non faite.
    var currentIndex: Int? {
        if let current, let index = steps.firstIndex(where: { $0.id == current }) { return index }
        return steps.firstIndex { $0.state == .doing } ?? steps.firstIndex { $0.state != .done }
    }
}

struct PlanStep: Decodable, Equatable, Sendable {
    var id: String?
    var text: String?
    var status: String?
    var group: String?

    var state: TaskStatus { TaskStatus(raw: status) }
    /// « L2.24 Icônes de fin de partie ».
    var label: String {
        [id, text].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " ")
    }
}

enum TaskStatus: String, Sendable {
    case done, doing, todo

    init(raw: String?) {
        switch raw {
        case "done", "completed": self = .done
        case "doing", "in_progress": self = .doing
        default: self = .todo
        }
    }
}

struct TaskItem: Decodable, Equatable, Sendable {
    var text: String?
    var status: String?

    var state: TaskStatus { TaskStatus(raw: status) }
}

struct ChapterStats: Decodable, Equatable, Sendable {
    var workflows: Int?
    var agents: Int?
    var artifacts: Int?
    var files: Int?
    var tests: Int?
    var testsFailed: Int?
    var commits: Int?
}

struct Chapter: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var prompt: String?
    @FlexDate var start: Date?
    @FlexDate var end: Date?
    var durationMs: Double?
    @Tolerant var stats: ChapterStats?
    var outcome: String?
}

enum ItemKind: String, Sendable {
    case command, commit, push, file, web, mcp, agent, question, other

    init(raw: String?) { self = raw.flatMap(ItemKind.init(rawValue:)) ?? .other }
}

enum Decision: String, Sendable {
    case auto, you, blocked, waiting, denied, unknown

    init(raw: String?) { self = raw.flatMap(Decision.init(rawValue:)) ?? .unknown }
}

struct AcceptedItem: Decodable, Equatable, Sendable {
    @FlexDate var ts: Date?
    var kind: String?
    var title: String?
    var detail: String?
    var decision: String?
    var agent: String?

    var itemKind: ItemKind { ItemKind(raw: kind) }
    var decisionKind: Decision { Decision(raw: decision) }
}

struct ActivityItem: Decodable, Equatable, Sendable {
    @FlexDate var ts: Date?
    var kind: String?
    var title: String?
    var detail: String?
    var agent: String?
    var ok: Bool?
}

struct AgentsState: Decodable, Equatable, Sendable {
    @Lossy var running: [AgentRun]
    @Lossy var done: [AgentRun]
}

struct AgentRun: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var title: String?
    var type: String?
    var workflow: String?
    var phase: String?
    @FlexDate var startedAt: Date?
    @FlexDate var lastAt: Date?
    var durationMs: Double?
    var actions: Int?
    var files: Int?
    var tests: Int?
    var status: String?
    var lastAction: String?
}

struct Workflow: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var name: String?
    var summary: String?
    var status: String?
    @FlexDate var startedAt: Date?
    var durationMs: Double?
    var agents: Int?
    var tokens: Int?
    @Lossy var phases: [String]
}

struct Artifact: Decodable, Equatable, Sendable {
    var title: String?
    var url: String?
    var description: String?
    @FlexDate var ts: Date?
    var publishes: Int?
}

enum FileKind: String, Sendable {
    case code, style, page, doc, data, image, media, config, other

    init(raw: String?) { self = raw.flatMap(FileKind.init(rawValue:)) ?? .other }
}

enum FileLocation: String, Sendable, CaseIterable {
    case project, elsewhere, scratch

    init(raw: String?) { self = raw.flatMap(FileLocation.init(rawValue:)) ?? .elsewhere }
}

struct FileItem: Decodable, Equatable, Sendable {
    var path: String
    var name: String?
    var ext: String?
    var kind: String?
    var created: Bool?
    var writes: Int?
    @FlexDate var ts: Date?
    var by: String?
    var location: String?

    var fileKind: FileKind { FileKind(raw: kind) }
    var fileLocation: FileLocation { FileLocation(raw: location) }
    var displayName: String { name ?? (path as NSString).lastPathComponent }
}

enum TestKind: String, Sendable {
    case tests, e2e, types, lint, build, other

    init(raw: String?) { self = raw.flatMap(TestKind.init(rawValue:)) ?? .other }
}

struct TestRun: Decodable, Equatable, Sendable {
    @FlexDate var ts: Date?
    var kind: String?
    var ok: Bool?
    var passed: Int?
    var failed: Int?
    var title: String?
    var command: String?
    var by: String?
    /// Échec attendu (étape « rouge » d'un test écrit avant le code).
    var expectedFail: Bool?
    /// Encore en cours.
    var pending: Bool?
    /// Première ligne d'erreur.
    var line: String?

    var testKind: TestKind { TestKind(raw: kind) }

    enum Outcome: Sendable { case passed, failed, expectedFail, pending, unknown }

    /// Sans résultat lisible (ok absent : sortie non reconnue, Codex), ce n'est ni une réussite ni un échec.
    var outcome: Outcome {
        if pending == true { return .pending }
        if ok == true { return .passed }
        if expectedFail == true { return .expectedFail }
        return ok == false ? .failed : .unknown
    }
}

enum MCPScope: String, Sendable {
    case project, user, local, connector, plugin, other

    init(raw: String?) { self = raw.flatMap(MCPScope.init(rawValue:)) ?? .other }
}

struct ConversationMCP: Decodable, Equatable, Sendable {
    var name: String
    var scope: String?
    var service: String?
    @FlexDate var lastTs: Date?
    var uses: Int?
    var enabled: Bool?
    /// Dernier état connu pour le dossier et le compte de la conversation.
    var status: String?

    var mcpScope: MCPScope { MCPScope(raw: scope) }
    var mcpStatus: MCPStatus { MCPStatus(raw: status) }
}

struct TokenCounts: Decodable, Equatable, Sendable {
    var input: Int?
    var output: Int?
    var cacheRead: Int?
    var cacheWrite: Int?
}

struct TokenState: Decodable, Equatable, Sendable {
    @Tolerant var today: TokenCounts?
    @Tolerant var total: TokenCounts?
}

struct LimitHit: Decodable, Equatable, Sendable {
    @FlexDate var ts: Date?
    var text: String?
}
