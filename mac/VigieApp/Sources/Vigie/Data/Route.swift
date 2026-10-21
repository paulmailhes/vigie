import Foundation

/// Ce qui est affiché à droite de la barre latérale.
enum Route: Hashable, Sendable {
    case overview
    case conversation(String)
    case account(String)
    case mcp
    /// Toutes les demandes et leur issue (filtres dans le store : historyStatus, historyWindow…).
    case history
}

/// Les onglets du détail d'une conversation.
enum ConversationTab: String, CaseIterable, Identifiable, Sendable {
    case fil, files, agents, tests, mcp

    var id: String { rawValue }

    var title: String {
        switch self {
        case .fil: "Fil"
        case .files: "Fichiers"
        case .agents: "Agents"
        case .tests: "Tests"
        case .mcp: "MCP"
        }
    }

    /// Une ligne sous l'onglet : ce qu'on y trouve.
    var subtitle: String {
        switch self {
        case .fil: "Ce qui compte, du plus récent au plus ancien"
        case .files: "Créés ou modifiés, et ce qui a été publié"
        case .agents: "Les assistants lancés en fond"
        case .tests: "Tests, types, build"
        case .mcp: "Les outils branchés à cette conversation"
        }
    }

    /// Nom court pour les fichiers de captures.
    var slug: String {
        switch self {
        case .fil: "fil"
        case .files: "fichiers"
        case .agents: "agents"
        case .tests: "tests"
        case .mcp: "mcp"
        }
    }
}

/// Un message d'une ligne en bas de la fenêtre.
struct Toast: Equatable, Identifiable, Sendable {
    let id = UUID()
    let text: String
    let isError: Bool
}

/// État de la liaison avec le moteur.
enum Connection: Equatable, Sendable {
    case connecting
    case ok
    case down
    case failing(String)
}

/// Les onglets de la fenêtre Réglages.
enum SettingsTab: String, Hashable, Sendable {
    case guards, notifications, updates
}
