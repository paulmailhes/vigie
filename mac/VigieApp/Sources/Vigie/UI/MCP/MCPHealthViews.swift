import SwiftUI

/// Libellés et couleurs de l'état réel d'un MCP (vert, orange, rouge : seules couleurs de la rangée).
enum MCPStatusStyle {
    static func label(_ status: MCPStatus) -> String {
        switch status {
        case .connected: "connecté"
        case .needsAuth: "à connecter"
        case .failed: "en échec"
        case .pendingApproval: "à approuver dans Claude Code"
        case .disabled: "coupé"
        case .unknown: "pas encore vérifié"
        }
    }

    static func color(_ status: MCPStatus) -> Color {
        switch status {
        case .connected: .secondary            // tout va bien : neutre, la couleur ne signale qu'un problème
        case .needsAuth, .pendingApproval: Theme.warn
        case .failed: Theme.alert
        case .disabled, .unknown: .secondary
        }
    }

    /// Les mêmes symboles que les lignes d'état sous un MCP.
    static func symbol(_ status: MCPStatus) -> String {
        switch status {
        case .connected: "checkmark.circle"
        case .needsAuth: "person.crop.circle.badge.exclamationmark"
        case .failed: "xmark.octagon.fill"
        case .pendingApproval: "hourglass"
        case .disabled: "pause.circle"
        case .unknown: "circle.dashed"
        }
    }

    /// Plein = état sûr ; cerclé = en attente, coupé ou inconnu.
    static func isFilled(_ status: MCPStatus) -> Bool {
        switch status {
        case .connected, .needsAuth, .failed: true
        case .pendingApproval, .disabled, .unknown: false
        }
    }

    /// Le dernier contrôle parmi plusieurs états.
    static func lastCheck(_ health: [MCPHealth]) -> Date? {
        health.compactMap(\.checkedAt).max()
    }
}

