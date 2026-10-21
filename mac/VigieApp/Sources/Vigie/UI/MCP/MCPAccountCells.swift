import SwiftUI

// Une colonne par compte, partout sur la page MCP : on lit d'un coup d'œil où un MCP marche,
// où il faut l'autoriser (orange, un clic), où il échoue (rouge), où il manque.
// Chaque compte Claude garde sa propre autorisation : il faut connecter un MCP une fois par compte.

enum MCPColumns {
    static let cell: CGFloat = 92
}

/// En-tête des colonnes : le nom de chaque compte, au-dessus de ses cases.
struct MCPAccountsHeader: View {
    @Environment(VigieStore.self) private var store
    /// Largeur réservée à droite des cases (bouton « partout », utilisations, interrupteur, menu).
    var trailing: CGFloat = 0

    var body: some View {
        HStack(spacing: 6) {
            Text("Une autorisation par compte : connecte chaque MCP une fois sur chacun.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
            Spacer(minLength: 8)
            ForEach(store.accounts) { account in
                Text(account.displayName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: MCPColumns.cell)
                    .opacity(account.isConnected ? 1 : Theme.dim)
            }
            Color.clear.frame(width: trailing, height: 1)
        }
    }
}

/// Les cases d'un MCP, une par compte.
struct MCPAccountCells: View {
    @Environment(VigieStore.self) private var store
    let name: String
    let health: [MCPHealth]
    /// Comptes qui déclarent ce MCP (vide : on ne sait pas, toutes les cases sont lues dans `health`).
    var declaredIn: [String] = []
    /// Dossier du projet (MCP de projet) ; nil pour un MCP du Mac.
    var path: String?
    /// Ajouter ce MCP à un compte où il manque (MCP du Mac seulement).
    var addTo: ((String) -> Void)?

    var body: some View {
        HStack(spacing: 6) {
            ForEach(store.accounts) { account in
                MCPAccountCell(name: name, account: account, entry: health.first { $0.accountId == account.id },
                               missing: !declaredIn.isEmpty && !declaredIn.contains(account.id),
                               path: path, addTo: addTo)
                    .frame(width: MCPColumns.cell)
            }
        }
    }
}

/// Une case : OK (neutre), Connecter (orange), Échec (rouge), Ajouter (manquant), « — » (pas encore vérifié).
struct MCPAccountCell: View {
    @Environment(VigieStore.self) private var store
    let name: String
    let account: Account
    let entry: MCPHealth?
    let missing: Bool
    let path: String?
    let addTo: ((String) -> Void)?

    var body: some View {
        Group {
            if !account.isConnected {
                Text("—").foregroundStyle(.tertiary)
                    .help("\(account.displayName) n'est pas connecté")
            } else if missing {
                if let addTo {
                    Button("Ajouter") { addTo(account.id) }
                        .buttonStyle(.borderless)
                        .foregroundStyle(.secondary)
                        .help("« \(name) » n'est pas dans \(account.displayName) : l'y ajouter, avec la même configuration")
                } else {
                    Text("absent").foregroundStyle(.tertiary)
                }
            } else {
                switch entry?.mcpStatus ?? .unknown {
                case .connected:
                    Image(systemName: "checkmark")
                        .foregroundStyle(.secondary)
                        .contextMenu { reconnectButton }
                        .help(help("connecté"))
                case .needsAuth:
                    Button("Connecter") { connect(force: false) }
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.warn)
                        .controlSize(.small)
                        .help("Ouvre la page d'autorisation de « \(name) » pour \(account.displayName) dans ton navigateur")
                case .failed:
                    Menu("Échec") {
                        reconnectButton
                        Button("Vérifier de nouveau", systemImage: "arrow.triangle.2.circlepath") {
                            Task { await store.mcpCheck(accountId: account.id, path: path) }
                        }
                    }
                    .menuStyle(.button)
                    .buttonStyle(.borderless)
                    .foregroundStyle(Theme.alert)
                    .fixedSize()
                    .help(help("en échec"))
                case .pendingApproval:
                    Text("à approuver").foregroundStyle(Theme.warn)
                        .help(help("en attente d'approbation : ouvre Claude Code dans ce dossier pour l'approuver"))
                case .disabled:
                    Text("coupé").foregroundStyle(.tertiary)
                        .help(help("coupé"))
                case .unknown:
                    Text("—").foregroundStyle(.tertiary)
                        .help("Pas encore vérifié sur \(account.displayName)")
                }
            }
        }
        .font(.callout)
    }

    private var reconnectButton: some View {
        Button("Refaire l'autorisation", systemImage: "arrow.clockwise") { connect(force: true) }
    }

    private func connect(force: Bool) {
        Task { await store.mcpConnect(name: name, accountId: account.id, path: path, force: force) }
    }

    private func help(_ state: String) -> String {
        var text = "\(account.displayName) : \(state)"
        if let checked = entry?.checkedAt { text += " · vérifié \(Fmt.when(checked, now: store.now))" }
        if let message = entry?.message, !message.isEmpty { text += "\n\(message)" }
        return text
    }
}

/// « Connecter partout » : chaque compte qui le demande, l'un après l'autre.
struct MCPConnectEverywhereButton: View {
    @Environment(VigieStore.self) private var store
    let name: String
    let health: [MCPHealth]

    var body: some View {
        let waiting = health.filter { [.needsAuth, .failed].contains($0.mcpStatus) && store.account($0.accountId)?.isConnected == true }
        if waiting.count > 1 {
            Button("Partout") {
                Task { await store.mcpConnectEverywhere(name: name) }
            }
            .buttonStyle(.borderless)
            .help("Connecter « \(name) » sur \(waiting.compactMap { store.account($0.accountId)?.displayName }.joined(separator: ", ")), un compte après l'autre")
        } else {
            Color.clear.frame(width: 1, height: 1)
        }
    }
}
