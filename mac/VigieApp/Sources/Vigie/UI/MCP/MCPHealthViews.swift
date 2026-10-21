import SwiftUI

/// Libellés et couleurs de l'état réel d'un MCP (vert, orange, rouge : seules couleurs de la rangée).
enum MCPStatusStyle {
    static func label(_ status: MCPStatus) -> String {
        switch status {
        case .connected: "connecté"
        case .needsAuth: "à connecter"
        case .failed: "en échec"
        case .pendingApproval: "en attente d'approbation"
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

struct HealthDot: View {
    let status: MCPStatus
    var size: CGFloat = 7

    var body: some View {
        Group {
            if MCPStatusStyle.isFilled(status) {
                Circle().fill(MCPStatusStyle.color(status))
            } else {
                Circle().strokeBorder(MCPStatusStyle.color(status), lineWidth: 1.5)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// Une petite pastille par compte : point d'état + nom du compte ; l'heure du contrôle au survol.
struct HealthPills: View {
    @Environment(VigieStore.self) private var store
    let health: [MCPHealth]

    var body: some View {
        if !health.isEmpty {
            HStack(spacing: 8) {
                ForEach(Array(ordered.enumerated()), id: \.offset) { _, entry in
                    pill(entry)
                }
            }
            .fixedSize()
        }
    }

    private var ordered: [MCPHealth] {
        let order = store.accounts.map(\.id)
        return health.sorted {
            (order.firstIndex(of: $0.accountId ?? "") ?? order.count) < (order.firstIndex(of: $1.accountId ?? "") ?? order.count)
        }
    }

    private func pill(_ entry: MCPHealth) -> some View {
        let name = entry.accountId.map { store.account($0)?.displayName ?? $0 } ?? "Ce Mac"
        let status = entry.mcpStatus
        var help = "\(name) : \(MCPStatusStyle.label(status))"
        if let checked = entry.checkedAt { help += " · vérifié \(Fmt.when(checked, now: store.now))" }
        if let message = entry.message, !message.isEmpty { help += "\n\(message)" }
        return HStack(spacing: 4) {
            HealthDot(status: status)
            Text(name)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .help(help)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(help)
    }
}

/// « Connecter » sur une ligne à connecter : un compte, ou un menu s'il y en a plusieurs.
struct MCPConnectButton: View {
    @Environment(VigieStore.self) private var store
    let name: String
    let health: [MCPHealth]
    var legacyNeedsAuth = false
    let path: String?

    var body: some View {
        let targets = health.filter { $0.mcpStatus == .needsAuth }
        Group {
            if targets.count > 1 {
                Menu("Connecter") {
                    ForEach(Array(targets.enumerated()), id: \.offset) { _, entry in
                        Button(entry.accountId.map { store.account($0)?.displayName ?? $0 } ?? "Ce Mac") {
                            connect(entry.accountId)
                        }
                    }
                }
                .menuStyle(.button)
                .fixedSize()
            } else if let target = targets.first {
                Button("Connecter") { connect(target.accountId) }
            } else if health.isEmpty && legacyNeedsAuth {
                Button("Connecter") { connect(nil) }
            }
        }
        .glassButton()
        .controlSize(.small)
        .help("Ouvre la page d'autorisation de « \(name) » dans ton navigateur")
    }

    private func connect(_ accountId: String?) {
        Task { await store.mcpConnect(name: name, accountId: accountId, path: path) }
    }
}
