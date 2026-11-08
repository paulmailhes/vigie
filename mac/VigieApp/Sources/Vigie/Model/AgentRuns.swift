import Foundation

/// Un lancement d'agent de Vigie et le rapport que l'agent tient à jour (<dossier>/.vigie/rapport-<id>.json, vérifié
/// par le moteur). L'app le lit dans le détail de la conversation qu'il a ouverte (`agentRun`) : sa tuile « Agent
/// Vigie » et son panneau Rapport. Le moteur donne aussi la liste (GET /api/v2/agents/runs), que l'app ne lit plus.
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

    /// Le verdict de l'agent, s'il en a écrit un : `verdict`, sinon `title`. Jamais le nom de l'agent : juste après le
    /// lancement, le moteur écrit un rapport de départ « en cours » qui a ce nom pour titre (déjà le titre du panneau).
    var verdict: String? {
        for text in [report?.verdict, report?.title] {
            guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { continue }
            let isName = [displayName, agent].contains { $0.caseInsensitiveCompare(text) == .orderedSame }
            if !isName { return text }
        }
        return nil
    }
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
    /// Ce que l'agent peut faire ensuite à ta demande : un bouton envoie le message dans sa conversation.
    @Lossy var next: [AgentNextStep]

    var isRunning: Bool { status == nil || status == "running" }
    var isBlocked: Bool { status == "blocked" }
    var openTodo: [AgentTodo] { todo.filter { !$0.done } }
}

struct AgentNextStep: Decodable, Equatable, Sendable, Identifiable {
    var label: String
    var message: String
    var id: String { label }
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
