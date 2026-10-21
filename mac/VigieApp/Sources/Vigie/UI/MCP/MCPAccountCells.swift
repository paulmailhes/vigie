import SwiftUI

// L'état d'un MCP sur chaque compte, résumé : ce qui marche en une mention, ce qui est à régler avec son geste.
// Chaque compte Claude garde sa propre autorisation : il faut connecter un MCP une fois par compte.

/// L'état d'un MCP sur tes comptes Claude, en une ligne : « ✓ tous tes comptes » quand tout va bien, sinon
/// seulement les comptes à régler, chacun avec son geste (Connecter, Ajouter, Échec). Tient avec beaucoup de comptes.
struct MCPAccountCells: View {
    @Environment(VigieStore.self) private var store
    let name: String
    let health: [MCPHealth]
    /// Comptes qui déclarent ce MCP (vide : on ne sait pas, l'état est lu dans `health`).
    var declaredIn: [String] = []
    /// Dossier du projet (MCP de projet) ; nil pour un MCP du Mac.
    var path: String?
    /// Ajouter ce MCP à un compte où il manque (MCP du Mac seulement).
    var addTo: ((String) -> Void)?
    /// Limiter à ces comptes (MCP du compte : le sien seulement).
    var only: [String]? = nil

    private var accounts: [Account] {
        store.accounts.filter { !$0.isCodex && $0.isConnected && (only == nil || only!.contains($0.id)) }
    }

    private enum State { case ok, connect, failed, missing, pending, off, unknown }

    private func state(_ account: Account) -> State {
        if !declaredIn.isEmpty && !declaredIn.contains(account.id) { return .missing }
        switch health.first(where: { $0.accountId == account.id })?.mcpStatus ?? .unknown {
        case .connected: return .ok
        case .needsAuth: return .connect
        case .failed: return .failed
        case .pendingApproval: return .pending
        case .disabled: return .off
        case .unknown: return .unknown
        }
    }

    var body: some View {
        let states = accounts.map { ($0, state($0)) }
        // Tout va bien : rien à montrer (l'utilisateur : « tous les comptes tout le temps, on affiche les problèmes »).
        let issues = states.filter { $0.1 != .ok && $0.1 != .unknown }
        HStack(spacing: 6) {
            ForEach(issues.prefix(3), id: \.0.id) { account, st in
                chip(account, st)
            }
            if issues.count > 3 {
                Text("+\(issues.count - 3)").font(.caption).foregroundStyle(.secondary)
            }
        }
        .fixedSize()
    }

    @ViewBuilder
    private func chip(_ account: Account, _ st: State) -> some View {
        switch st {
        case .connect:
            AsyncButton("\(account.displayName) · Connecter") { await store.mcpConnect(name: name, accountId: account.id, path: path) }
            .buttonStyle(.borderedProminent)
            .tint(Theme.warn)
            .controlSize(.small)
            .help("Ouvre la page d'autorisation de « \(name) » pour \(account.displayName) dans ton navigateur")
        case .failed:
            Menu("\(account.displayName) · échec") {
                Button("Refaire l'autorisation", systemImage: "arrow.clockwise") {
                    Task { await store.mcpConnect(name: name, accountId: account.id, path: path, force: true) }
                }
                Button("Vérifier de nouveau", systemImage: "arrow.triangle.2.circlepath") {
                    Task { await store.mcpCheck(accountId: account.id, path: path) }
                }
            }
            .menuStyle(.button)
            .buttonStyle(.borderless)
            .foregroundStyle(Theme.alert)
            .fixedSize()
        case .missing:
            if let addTo {
                Button("\(account.displayName) · Ajouter") { addTo(account.id) }
                    .buttonStyle(.borderless)
                    .help("« \(name) » n'est pas sur \(account.displayName) : l'y ajouter, avec la même configuration")
            } else {
                Text("absent de \(account.displayName)").font(.callout).foregroundStyle(.tertiary)
            }
        case .pending:
            Text("\(account.displayName) · à approuver").font(.callout).foregroundStyle(Theme.warn)
                .help("MCP de projet en attente d'approbation : ouvre Claude Code dans ce dossier")
        case .off:
            Text("\(account.displayName) · coupé").font(.callout).foregroundStyle(.tertiary)
        case .ok, .unknown:
            EmptyView()
        }
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
            AsyncButton("Partout") { await store.mcpConnectEverywhere(name: name) }
            .buttonStyle(.borderless)
            .help("Connecter « \(name) » sur \(waiting.compactMap { store.account($0.accountId)?.displayName }.joined(separator: ", ")), un compte après l'autre")
        } else {
            Color.clear.frame(width: 1, height: 1)
        }
    }
}
