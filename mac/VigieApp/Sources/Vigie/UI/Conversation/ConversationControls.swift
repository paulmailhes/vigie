import SwiftUI

/// Les réglages d'une conversation, dans la barre d'outils de sa page : son compte (bascule avec confirmation), son
/// auto-accept (comme le réglage général, toujours, jamais) et les MCP de ton compte claude.ai. Codex : l'auto-accept
/// seulement.
struct ConversationControls: View {
    @Environment(VigieStore.self) private var store
    let summary: ConversationSummary
    let contextTokens: Int?

    @State private var pendingAccount: Account?
    @State private var confirmSwitch = false
    /// Menu dont l'action attend le moteur (« account », « auto », « mcp ») : une roue tourne sur son libellé.
    @State private var busy: String?

    var body: some View {
        HStack(spacing: 8) {
            if summary.isCodex {
                Label("Codex", systemImage: "chevron.left.forwardslash.chevron.right")
                    .help("Conversation Codex (OpenAI), sur ton compte ChatGPT")
                autoAcceptMenu
            } else {
                accountMenu
                autoAcceptMenu
                connectorsMenu
            }
        }
        // dans la barre d'outils, un menu n'affiche que son icône : ici le texte compte
        .labelStyle(.titleAndIcon)
        .fixedSize()
        .confirmationDialog(pendingAccount.map { "Passer sur \($0.displayName) ?" } ?? "",
                            isPresented: $confirmSwitch, titleVisibility: .visible, presenting: pendingAccount) { account in
            Button(summary.state == .working ? "À la fin de son travail" : "Passer sur \(account.displayName)") {
                run("account") { await store.switchAccount(of: summary.id, to: account.id) }
            }
            if summary.state == .working {
                Button("Tout de suite (l'interrompt)") {
                    run("account") { await store.switchAccount(of: summary.id, to: account.id, now: true) }
                }
            }
            Button("Annuler", role: .cancel) {}
        } message: { account in
            Text(switchMessage(account))
        }
    }

    private func run(_ menu: String, _ work: @escaping @MainActor () async -> Void) {
        busy = menu
        Task { @MainActor in
            await work()
            if busy == menu { busy = nil }
        }
    }

    // MARK: Compte

    private var currentAccount: Account? { store.account(summary.accountId) }

    private var accountMenu: some View {
        Menu {
            Text("Compte de cette conversation")
            ForEach(store.accounts) { account in
                Button {
                    guard account.id != currentAccount?.id else { return }
                    pendingAccount = account
                    confirmSwitch = true
                } label: {
                    choice(account.isConnected ? account.displayName : "\(account.displayName) (pas connecté)",
                           selected: account.id == currentAccount?.id)
                }
                .disabled(!account.isConnected && account.id != currentAccount?.id)
            }
        } label: {
            BusyLabel(busy: busy == "account") { Label(currentAccount?.displayName ?? "Compte", systemImage: "person.crop.circle") }
        }
        .help("Compte de cette conversation")
    }

    private func switchMessage(_ account: Account) -> String {
        var text = summary.state == .working
            ? "Elle travaille : elle change de compte à la fin de son tour, ou tout de suite en l'interrompant (tu écris « continue » pour la reprendre)."
            : "Elle reprend sur \(account.displayName) avec tout son historique."
        if let contextTokens, contextTokens > 0 {
            text += " ≈ \(Fmt.tokens(contextTokens)) tokens relus sur le nouveau compte."
        }
        return text
    }

    // MARK: Auto-accept de cette conversation

    private var autoAcceptMenu: some View {
        Menu {
            Text("Auto-accept dans cette conversation")
            Button { run("auto") { await store.setAutoAccept(nil, for: summary.id) } } label: {
                choice("Comme le réglage général (\(store.autoAccept ? "oui" : "non"))", selected: summary.autoAcceptOverride == nil)
            }
            Button { run("auto") { await store.setAutoAccept(true, for: summary.id) } } label: {
                choice("Toujours", selected: summary.autoAcceptOverride == true)
            }
            Button { run("auto") { await store.setAutoAccept(false, for: summary.id) } } label: {
                choice("Jamais", selected: summary.autoAcceptOverride == false)
            }
        } label: {
            BusyLabel(busy: busy == "auto") {
                Label(autoAcceptText, systemImage: (summary.autoAccept ?? false) ? "checkmark.shield" : "shield.slash")
            }
        }
        .help("Auto-accept pour cette conversation seulement (le réglage général est l'interrupteur à droite)")
    }

    private var autoAcceptText: String {
        switch summary.autoAcceptOverride {
        case true?: "Auto : toujours"
        case false?: "Auto : jamais"
        case nil: (summary.autoAccept ?? store.autoAccept) ? "Auto : oui" : "Auto : non"
        }
    }

    // MARK: MCP du compte

    private var connectorsMenu: some View {
        let on = summary.connectors == "on"
        return Menu {
            Text("MCP de ton compte claude.ai dans cette conversation")
            Button { run("mcp") { await store.setConnectors(false, for: summary.id) } } label: { choice("Coupés (recommandé)", selected: !on) }
            Button { run("mcp") { await store.setConnectors(true, for: summary.id) } } label: { choice("Activés", selected: on) }
        } label: {
            BusyLabel(busy: busy == "mcp") { Label(on ? "MCP : activés" : "MCP : coupés", systemImage: Icon.mcp) }
        }
        .help("Les MCP de ton compte claude.ai (Gmail, Drive…) dans cette conversation. Les MCP de ton Mac et du projet restent actifs.")
    }

    @ViewBuilder
    private func choice(_ text: String, selected: Bool) -> some View {
        if selected { Label(text, systemImage: "checkmark") } else { Text(text) }
    }
}
