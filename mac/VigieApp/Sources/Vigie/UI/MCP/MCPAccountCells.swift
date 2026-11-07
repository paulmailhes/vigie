import SwiftUI

// L'état d'un MCP sur tes comptes Claude. Rien quand tout marche (« on affiche les problèmes »). Ce qui demande un
// geste (à connecter, en échec, à approuver) est rangé dans « À régler », en tête de la page, une ligne par MCP et par
// compte ; sous le MCP restent les remarques (absent d'un compte, coupé). Chaque compte Claude garde sa propre
// autorisation : un MCP en direct (pas par Vigie) se connecte une fois par compte.

/// Les comptes d'un MCP, rangés par état (comptes Claude connectés seulement).
struct MCPAccountSummary {
    var connect: [Account] = []
    var failed: [Account] = []
    var missing: [Account] = []
    var pending: [Account] = []
    var off: [Account] = []

    var isEmpty: Bool { connect.isEmpty && failed.isEmpty && missing.isEmpty && pending.isEmpty && off.isEmpty }

    /// Les remarques sous le MCP (absent, coupé) ; le reste est dans « À régler ».
    var hasNotes: Bool { !missing.isEmpty || !off.isEmpty }

    /// La puce à côté du nom : le plus grave d'abord.
    var status: MCPRowStatus? {
        if !failed.isEmpty { return MCPRowStatus(text: "en échec", tone: .alert) }
        if !connect.isEmpty { return MCPRowStatus(text: "à connecter", tone: .warn) }
        if !pending.isEmpty { return MCPRowStatus(text: "à approuver", tone: .warn) }
        return nil
    }

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
                .accessibilityHidden(true)
            Text(text)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 12)
            action()
        }
        .font(.callout)
    }
}

/// Les remarques d'un MCP sur tes comptes (absent d'un compte, coupé), une ligne par sorte.
struct MCPAccountIssues: View {
    let name: String
    let summary: MCPAccountSummary
    /// Ajouter ce MCP aux comptes où il manque (MCP du Mac seulement).
    var addTo: (([String]) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !summary.missing.isEmpty {
                MCPIssueLine(systemImage: "plus.circle", color: .secondary,
                             text: "Absent de \(MCPAccountSummary.names(summary.missing))") {
                    if let addTo {
                        Button("Ajouter") { addTo(summary.missing.map(\.id)) }
                            .glassButton()
                            .controlSize(.small)
                            .help("Ajoute « \(name) » à \(MCPAccountSummary.names(summary.missing)), avec la même configuration")
                    }
                }
            }
            if !summary.off.isEmpty {
                MCPIssueLine(systemImage: "pause.circle", color: .secondary,
                             text: "Coupé sur \(MCPAccountSummary.names(summary.off))") { EmptyView() }
            }
        }
    }
}
