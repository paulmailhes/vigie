import Foundation

/// GET /api/v2/agents/runs : les derniers lancements d'agents et le rapport que chaque agent tient à jour
/// (<dossier>/.vigie/rapport-<id>.json, vérifié par le moteur).
struct RecipeRunList: Decodable, Equatable, Sendable {
    @Lossy var runs: [RecipeRun]
}

struct RecipeRun: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var agent: String
    var name: String?
    var icon: String?
    var folder: String
    var surface: String?
    /// La conversation à rouvrir (celle reprise, sinon la plus récente du dossier depuis le lancement).
    var conversation: String?
    @FlexDate var at: Date?
    @Tolerant var report: AgentReport?
    var reportFile: String?
    var unreadable: Bool?
    @FlexDate var changedAt: Date?

    var displayName: String { name ?? agent }
    var project: String { (folder as NSString).lastPathComponent }
}

struct AgentReport: Decodable, Equatable, Sendable {
    /// running : en cours ; done : terminé ; blocked : l'agent ne peut pas continuer.
    var status: String?
    /// ok : rien à faire ; warn : des actions restent ; block : un point bloquant.
    var level: String?
    var title: String?
    var verdict: String?
    var counts: AgentReportCounts?
    /// Le rapport détaillé, chemin dans le dossier du projet.
    var report: String?
    @Lossy var links: [AgentReportLink]
    @Lossy var done: [String]
    @Lossy var todo: [AgentTodo]

    var isRunning: Bool { status == nil || status == "running" }
    var isBlocked: Bool { status == "blocked" }
    var openTodo: [AgentTodo] { todo.filter { !$0.done } }
}

struct AgentReportCounts: Decodable, Equatable, Sendable {
    var ok: Int?
    var warn: Int?
    var block: Int?
}

struct AgentReportLink: Decodable, Equatable, Sendable, Identifiable {
    var label: String
    var url: String
    var id: String { url }
}

/// Une action qui reste à l'utilisateur ; `index` : sa place dans le fichier (pour la cocher).
struct AgentTodo: Decodable, Equatable, Sendable, Identifiable {
    var index: Int
    var text: String
    var `where`: String?
    var severity: String?
    var done: Bool

    var id: Int { index }
}
