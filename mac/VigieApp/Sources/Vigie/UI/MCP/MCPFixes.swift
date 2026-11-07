import SwiftUI

/// Une chose à régler sur un MCP, pour un compte : la connecter, voir son erreur, l'approuver dans Claude Code, la
/// vérifier. La page MCP les réunit en tête, dans « À régler », au lieu de les laisser éparpillés sous chaque MCP.
struct MCPFix: Identifiable, Equatable {
    enum Kind: Equatable {
        /// Pas encore autorisé sur ce compte.
        case connect
        /// En échec sur ce compte (l'erreur du dernier contrôle dans `message`).
        case failed
        /// MCP de projet en attente d'approbation dans Claude Code (`accounts` : sur quels comptes).
        case approve
        /// MCP du Mac qui demande une connexion, pas encore vérifié sur les comptes.
        case verify
        /// MCP qui passe par Vigie : pas encore connecté, ou accès coupé par le service.
        case gateway
    }

    let kind: Kind
    let name: String
    let service: String?
    /// Les comptes concernés (un seul pour connecter ou une erreur ; aucun pour la passerelle et la vérification).
    var accounts: [Account] = []
    /// Dossier du projet (MCP de projet) ; nil pour un MCP du Mac ou du compte.
    var path: String? = nil
    /// D'où il vient : « MCP de ton Mac », le nom du projet, « MCP du compte ».
    let origin: String
    /// L'erreur du dernier contrôle (en échec) ou la phrase de la passerelle.
    var message: String? = nil

    var id: String { "\(kind)|\(name)|\(path ?? "")|\(accounts.map(\.id).joined(separator: ","))" }

    /// Ce qui est à régler, en mots : « À connecter sur Perso ».
    var text: String {
        let names = MCPAccountSummary.names(accounts)
        switch kind {
        case .connect: return "À connecter sur \(names)"
        case .failed: return "En échec sur \(names)"
        case .approve: return "À approuver dans Claude Code, sur \(names)"
        case .verify: return "À connecter, pas encore vérifié sur tes comptes"
        case .gateway: return message ?? "Pas encore connecté"
        }
    }

    /// Tout ce qui est à régler, dans l'ordre de la page : MCP du Mac, des projets, du compte.
    static func all(in mcp: MCPState, accounts: [Account]) -> [MCPFix] {
        var fixes: [MCPFix] = []
        for server in mcp.user {
            let origin = Theme.title(for: .mac)
            if let gateway = mcp.gateway?[server.name] {
                if GatewayLine.needsFix(gateway) {
                    fixes.append(MCPFix(kind: .gateway, name: server.name, service: server.service, origin: origin,
                                        message: GatewayLine.fixText(gateway)))
                }
                continue
            }
            let summary = MCPAccountSummary(accounts: accounts, health: server.health, declaredIn: server.accounts)
            fixes += perAccount(summary, name: server.name, service: server.service, health: server.health,
                                path: nil, origin: origin)
            if summary.isEmpty && server.health.isEmpty && server.needsAuth == true {
                fixes.append(MCPFix(kind: .verify, name: server.name, service: server.service, origin: origin))
            }
        }
        for project in mcp.projects + mcp.local {
            for server in project.servers {
                let summary = MCPAccountSummary(accounts: accounts, health: server.health)
                fixes += perAccount(summary, name: server.name, service: server.service, health: server.health,
                                    path: project.path, origin: project.displayName)
            }
        }
        for connector in mcp.connectors {
            let summary = MCPAccountSummary(accounts: accounts, health: connector.health, only: connector.accountId.map { [$0] })
            fixes += perAccount(summary, name: connector.name, service: connector.service, health: connector.health,
                                path: nil, origin: "MCP du compte")
        }
        return fixes
    }

    /// Une ligne par compte à connecter ou en échec ; une seule pour l'approbation (elle se fait dans le projet).
    private static func perAccount(_ summary: MCPAccountSummary, name: String, service: String?, health: [MCPHealth],
                                   path: String?, origin: String) -> [MCPFix] {
        var fixes: [MCPFix] = []
        for account in summary.failed {
            let message = health.first { $0.accountId == account.id }?.message
            fixes.append(MCPFix(kind: .failed, name: name, service: service, accounts: [account], path: path,
                                origin: origin, message: message))
        }
        for account in summary.connect {
            fixes.append(MCPFix(kind: .connect, name: name, service: service, accounts: [account], path: path, origin: origin))
        }
        if !summary.pending.isEmpty {
            fixes.append(MCPFix(kind: .approve, name: name, service: service, accounts: summary.pending, path: path, origin: origin))
        }
        return fixes
    }
}

/// Une ligne de « À régler » : le MCP, ce qui ne va pas et d'où il vient, le geste. Fenêtre étroite : le geste passe
/// sous le texte.
struct MCPFixRow: View {
    @Environment(VigieStore.self) private var store
    let fix: MCPFix

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: 10) {
                label
                    .frame(minWidth: 200, idealWidth: 320, maxWidth: .infinity, alignment: .leading)
                action
            }
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 8) {
                    label
                    action
                }
                Spacer(minLength: 0)
            }
        }
        .padding(.vertical, 2)
    }

    private var label: some View {
        HStack(alignment: .center, spacing: 10) {
            ServiceGlyph(service: fix.service, name: fix.name)
            VStack(alignment: .leading, spacing: 2) {
                Text(fix.name)
                    .textRole(.item)
                    .lineLimit(1)
                InfoLine(parts: [fix.text, fix.origin])
            }
        }
    }

    @ViewBuilder
    private var action: some View {
        switch fix.kind {
        case .connect:
            if let account = fix.accounts.first {
                AsyncButton("Connecter") { await store.mcpConnect(name: fix.name, accountId: account.id, path: fix.path) }
                    .glassButton(.primary)
                    .controlSize(.small)
                    .help("Ouvre la page de connexion de « \(fix.name) » pour \(account.displayName) dans ton navigateur")
            }
        case .failed:
            MCPErrorButton(fix: fix)
        case .approve:
            Button("Approuver dans Claude Code") { approve() }
                .glassButton()
                .controlSize(.small)
                .help("Ouvre le projet dans VS Code : Claude Code te demande d'accepter ce MCP")
        case .verify:
            if store.verifying.contains(fix.name) {
                ProgressView()
                    .controlSize(.small)
            } else {
                AsyncButton("Vérifier") { await store.verifyMCP([fix.name], accountId: nil) }
                    .glassButton()
                    .controlSize(.small)
                    .help("Vérifie ce MCP seul, sur chacun de tes comptes (quelques secondes)")
            }
        case .gateway:
            if let server = store.mcp?.gateway?[fix.name] {
                GatewayLine(name: fix.name, server: server, mode: .fix)
            }
        }
    }

    /// Un MCP de projet s'approuve dans Claude Code, dans le dossier du projet : VS Code s'y ouvre.
    private func approve() {
        if let path = fix.path {
            SystemActions.openInVSCode(path: path)
        } else {
            SystemActions.activateVSCode()
        }
        store.show(info: "Dans une conversation Claude de ce projet, accepte « \(fix.name) » quand il te le propose")
    }
}

/// « Voir l'erreur » : le message du dernier contrôle, puis reconnecter ou vérifier de nouveau, pour ce compte.
struct MCPErrorButton: View {
    @Environment(VigieStore.self) private var store
    let fix: MCPFix
    @State private var showing = false

    var body: some View {
        Button("Voir l'erreur") { showing = true }
            .glassButton()
            .controlSize(.small)
            .popover(isPresented: $showing, arrowEdge: .bottom) {
                VStack(alignment: .leading, spacing: 12) {
                    CardTitle("Erreur de « \(fix.name) » sur \(MCPAccountSummary.names(fix.accounts))")
                    Text(fix.message ?? "Le dernier contrôle a échoué, sans message du service.")
                        .font(.callout)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 8) {
                        AsyncButton("Vérifier de nouveau") { await recheck() }
                            .glassButton()
                        AsyncButton("Reconnecter") { await reconnect() }
                            .glassButton(.primary)
                    }
                    .controlSize(.small)
                }
                .padding(16)
                .frame(width: 340, alignment: .leading)
            }
    }

    private func reconnect() async {
        showing = false
        for account in fix.accounts {
            await store.mcpConnect(name: fix.name, accountId: account.id, path: fix.path, force: true)
        }
    }

    /// Hors projet : vérifié seul (quelques secondes) ; d'un projet : le contrôle de ce dossier, pour ce compte.
    private func recheck() async {
        showing = false
        for account in fix.accounts {
            if fix.path == nil {
                await store.verifyMCP([fix.name], accountId: account.id)
            } else {
                await store.mcpCheck(accountId: account.id, path: fix.path)
            }
        }
    }
}
