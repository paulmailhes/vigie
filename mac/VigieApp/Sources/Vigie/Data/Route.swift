import Foundation

/// Ce qui est affiché à droite de la barre latérale.
enum Route: Hashable, Sendable {
    case overview
    case conversation(String)
    case account(String)
    case mcp
    /// Les recettes prêtes à lancer (dossier des agents, AGENT.md).
    case agents
    /// Toutes les demandes et leur issue (filtres dans le store : historyStatus, historyWindow…).
    case history
    /// Ce que les conversations ont laissé tourner (Chrome sans fenêtre, serveurs…).
    case background
}

/// Le détail ouvert à droite de la page d'une conversation (inspecteur).
enum ConversationPanel: Hashable, Sendable {
    /// Ta demande entière.
    case request
    /// Un message de Claude en entier (indice dans `messages`).
    case message(Int)
    /// Tous les échanges : une paire Toi / Claude par demande.
    case thread
    case agent(String)
    case workflow(String)
    case plan
    case tests
    case files
    case journal
    case mcp
    case background
    case answers
}

/// Une page de la pile Retour / Suivant (⌘[ ⌘]), avec le détail qu'elle avait ouvert à droite (page d'une
/// conversation) : il se rouvre au retour.
struct VisitedPage: Equatable, Sendable {
    var route: Route
    var panel: ConversationPanel?
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
    case general, guards, notifications, updates
}
