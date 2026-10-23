import SwiftUI

// L'état d'un MCP sur tes comptes Claude. Rien quand tout marche (« on affiche les problèmes ») ; sinon une ligne par
// sorte de problème, en toutes lettres, avec un seul geste à droite. Chaque compte Claude garde sa propre
// autorisation : un MCP en direct (pas par Vigie) se connecte une fois par compte.

/// Les comptes d'un MCP, rangés par état (comptes Claude connectés seulement).
struct MCPAccountSummary {
    var connect: [Account] = []
    var failed: [Account] = []
    var missing: [Account] = []
    var pending: [Account] = []
    var off: [Account] = []

    var isEmpty: Bool { connect.isEmpty && failed.isEmpty && missing.isEmpty && pending.isEmpty && off.isEmpty }

    /// declaredIn : comptes qui déclarent ce MCP (vide : on ne sait pas, l'état est lu dans `health`) ;
    /// only : limiter à ces comptes (MCP du compte : le sien seulement).
    init(accounts: [Account], health: [MCPHealth], declaredIn: [String] = [], only: [String]? = nil) {
        for account in accounts where !account.isCodex && account.isConnected && (only?.contains(account.id) ?? true) {
            if !declaredIn.isEmpty && !declaredIn.contains(account.id) {
                missing.append(account)
                continue
            }
            switch health.first(where: { $0.accountId == account.id })?.mcpStatus ?? .unknown {
            case .needsAuth: connect.append(account)
            case .failed: failed.append(account)
            case .pendingApproval: pending.append(account)
            case .disabled: off.append(account)
            case .connected, .unknown: break
            }
        }
    }

    /// « Perso », « Perso et Boulot », « 3 comptes ».
    static func names(_ accounts: [Account]) -> String {
        if accounts.count > 3 { return "\(accounts.count) comptes" }
        return accounts.map(\.displayName).formatted(.list(type: .and).locale(Fmt.locale))
    }
}

/// Une ligne d'état sous un MCP : icône de couleur, phrase, geste à droite.
struct MCPIssueLine<Action: View>: View {
    let systemImage: String
    let color: Color
    let text: String
    @ViewBuilder var action: () -> Action

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: systemImage)
                .foregroundStyle(color)
                .frame(width: 16)
            Text(text)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 12)
            action()
        }
        .font(.callout)
    }
}

/// Les problèmes d'un MCP sur tes comptes, une ligne par sorte.
struct MCPAccountIssues: View {
    @Environment(VigieStore.self) private var store
    let name: String
    let summary: MCPAccountSummary
    /// Dossier du projet (MCP de projet) ; nil pour un MCP du Mac ou du compte.
    var path: String?
    /// Ajouter ce MCP aux comptes où il manque (MCP du Mac seulement).
    var addTo: (([String]) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !summary.connect.isEmpty {
                MCPIssueLine(systemImage: "person.crop.circle.badge.exclamationmark", color: Theme.warn,
                             text: "À connecter sur \(MCPAccountSummary.names(summary.connect))") {
                    connectButton
                }
            }
            if !summary.failed.isEmpty {
                MCPIssueLine(systemImage: "xmark.octagon.fill", color: Theme.alert,
                             text: "En échec sur \(MCPAccountSummary.names(summary.failed))") {
                    retryMenu
                }
            }
            if !summary.missing.isEmpty {
                MCPIssueLine(systemImage: "plus.circle", color: .secondary,
                             text: "Absent de \(MCPAccountSummary.names(summary.missing))") {
                    if let addTo {
                        Button("Ajouter") { addTo(summary.missing.map(\.id)) }
                            .controlSize(.small)
                            .help("Ajoute « \(name) » à \(MCPAccountSummary.names(summary.missing)), avec la même configuration")
                    }
                }
            }
            if !summary.pending.isEmpty {
                MCPIssueLine(systemImage: "hourglass", color: Theme.warn,
                             text: "À approuver dans Claude Code, sur \(MCPAccountSummary.names(summary.pending))") { EmptyView() }
                    .help("MCP de projet en attente d'approbation : ouvre Claude Code dans ce dossier et accepte-le")
            }
            if !summary.off.isEmpty {
                MCPIssueLine(systemImage: "pause.circle", color: .secondary,
                             text: "Coupé sur \(MCPAccountSummary.names(summary.off))") { EmptyView() }
            }
        }
    }

    /// Un compte : le connecter ; plusieurs : l'un après l'autre (une page d'autorisation à la fois).
    private var connectButton: some View {
        let accounts = summary.connect
        return AsyncButton(accounts.count == 1 ? "Connecter" : "Connecter les \(accounts.count) comptes") {
            if accounts.count == 1 || path != nil {
                for account in accounts { await store.mcpConnect(name: name, accountId: account.id, path: path) }
            } else {
                await store.mcpConnectEverywhere(name: name)
            }
        }
        .buttonStyle(.borderedProminent)
        .tint(Theme.warn)
        .controlSize(.small)
        .help(accounts.count == 1
              ? "Ouvre la page d'autorisation de « \(name) » pour \(accounts[0].displayName) dans ton navigateur"
              : "Ouvre la page d'autorisation de « \(name) » pour chaque compte, l'un après l'autre")
    }

    private var retryMenu: some View {
        Menu("Réessayer") {
            ForEach(summary.failed) { account in
                Section(account.displayName) {
                    Button("Refaire l'autorisation", systemImage: "arrow.clockwise") {
                        Task { await store.mcpConnect(name: name, accountId: account.id, path: path, force: true) }
                    }
                    Button("Vérifier de nouveau", systemImage: "arrow.triangle.2.circlepath") {
                        Task { await store.mcpCheck(accountId: account.id, path: path) }
                    }
                }
            }
        }
        .menuStyle(.button)
        .controlSize(.small)
        .fixedSize()
    }
}
