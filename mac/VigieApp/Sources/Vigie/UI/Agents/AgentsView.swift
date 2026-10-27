import SwiftUI

/// Agents : les recettes prêtes à lancer, livrées avec Vigie (agents/<id>/AGENT.md, remplacés à chaque mise à jour).
/// Une rangée par agent : ce qu'il fait, les MCP dont il a besoin et leur état, et « Lancer… » qui ouvre son formulaire.
struct AgentsView: View {
    @Environment(VigieStore.self) private var store
    @State private var launching: AgentInfo?

    var body: some View {
        Group {
            if let state = store.agentsState {
                if state.agents.isEmpty {
                    empty(state)
                } else {
                    content(state)
                }
            } else if let problem = store.agentsProblem {
                ContentUnavailableView {
                    Label("Agents indisponibles", systemImage: Icon.recipe)
                } description: {
                    Text(problem)
                }
            } else {
                LoadingView()
            }
        }
        .navigationTitle("Agents")
        .navigationSubtitle("Des recettes prêtes à lancer, qui s'appuient sur tes MCP")
        .toolbar {
            ToolbarItem {
                AsyncButton("Actualiser", systemImage: "arrow.clockwise") { await store.refreshAgents() }
                    .help("Relire les agents et l'état de leurs MCP")
            }
        }
        .sheet(item: $launching) { agent in
            AgentLaunchSheet(agent: agent)
        }
        .task(id: store.windowVisible) { await store.followAgents() }
    }

    private func content(_ state: AgentLibrary) -> some View {
        Form {
            Section {
                ForEach(state.agents) { agent in
                    AgentRecipeRow(agent: agent) { launching = agent }
                }
            } header: {
                MCPSectionHeader(title: "Les agents",
                                 text: "Chacun prépare le dossier du projet, puis ouvre une conversation Claude Code qui suit sa consigne, dans VS Code ou dans l'app Claude.")
            } footer: {
                footer(state)
            }
        }
        .pageForm()
    }

    private func footer(_ state: AgentLibrary) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let account = state.account, let name = account.displayName {
                HStack(spacing: 6) {
                    Label("Un agent lancé partira sur le compte \(name) (celui des nouvelles conversations).",
                          systemImage: Icon.account)
                    Button("Changer") { store.showAccounts(account.id) }
                        .buttonStyle(.link)
                        .help("Le compte des nouvelles conversations se choisit sur la page Comptes")
                }
            }
            Label("Les agents arrivent avec les mises à jour de Vigie.", systemImage: Icon.recipe)
        }
        .font(.callout)
        .foregroundStyle(.secondary)
        .padding(.top, 4)
    }

    private func empty(_ state: AgentLibrary) -> some View {
        ContentUnavailableView {
            Label("Aucun agent pour l'instant", systemImage: Icon.recipe)
        } description: {
            Text("Les agents arrivent avec les mises à jour de Vigie.")
        }
    }
}

/// Un agent : icône, nom, ce qu'il fait, ses MCP et leur état, « Lancer… ». Son AGENT.md est illisible : la raison
/// en rouge, et rien à lancer.
struct AgentRecipeRow: View {
    @Environment(VigieStore.self) private var store
    let agent: AgentInfo
    let launch: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AgentIcon(symbol: agent.icon)
            VStack(alignment: .leading, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(agent.displayName)
                        .fontWeight(.semibold)
                    if let description = agent.description, !description.isEmpty {
                        Text(description)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if let problem = agent.problem {
                    Label(problem, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout)
                        .foregroundStyle(Theme.alert)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !agent.mcp.isEmpty {
                    FlowLayout(spacing: 6) {
                        ForEach(agent.mcp) { AgentMCPBadge(mcp: $0) }
                        AgentMCPFixes(agent: agent)
                            .buttonStyle(.link)
                            .font(.caption)
                            .padding(.top, 3)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if agent.canLaunch {
                Button("Lancer…", action: launch)
                    .glassButton(.primary)
                    .help("Remplis son formulaire : Vigie prépare le dossier du projet et ouvre la conversation dans VS Code ou dans l'app Claude")
            }
        }
        .padding(.vertical, 6)
    }
}

/// Icône d'un agent : son symbole SF s'il existe, sinon la baguette.
struct AgentIcon: View {
    let symbol: String?
    var size: CGFloat = 20

    var body: some View {
        Image(systemName: Self.resolved(symbol))
            .symbolRenderingMode(.hierarchical)
            .font(.system(size: size))
            .foregroundStyle(.secondary)
            .frame(width: size + 10)
            .accessibilityHidden(true)
    }

    /// Un nom que macOS ne connaît pas dessinerait un vide : la baguette à la place.
    static func resolved(_ symbol: String?) -> String {
        guard let symbol, !symbol.isEmpty, NSImage(systemSymbolName: symbol, accessibilityDescription: nil) != nil else {
            return Icon.recipe
        }
        return symbol
    }
}

/// Un MCP nécessaire : son service (« Figma », quel que soit le nom du MCP) et son état en toutes lettres ; la couleur
/// seulement pour ce qui est à régler.
struct AgentMCPBadge: View {
    let mcp: AgentMCP

    var body: some View {
        let status = mcp.mcpStatus
        let label = mcp.isMissing ? "à ajouter" : MCPStatusStyle.label(status)
        let color = mcp.isMissing ? Theme.warn : MCPStatusStyle.color(status)
        HStack(spacing: 4) {
            Image(systemName: mcp.isMissing ? "plus.circle" : MCPStatusStyle.symbol(status))
                .imageScale(.small)
                .foregroundStyle(color)
            Text(mcp.title)
                .fontWeight(.medium)
            if let detail = mcp.chosenDetail {
                Text("· \(detail)")
                    .foregroundStyle(.secondary)
            }
            Text(label)
                .foregroundStyle(color)
        }
        .font(.caption)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(.quaternary, in: .capsule)
        .fixedSize()
        .help(mcp.servers.count > 1 ? "L'agent utilisera \(mcp.chosen ?? mcp.title) ; un autre se choisit au lancement" : "")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(mcp.title)\(mcp.chosenDetail.map { " (\($0))" } ?? "") : \(label)")
    }
}

/// Ce qui manque à un agent, réglable d'ici : « Ajouter Figma » (le MCP officiel, sur tous les comptes, puis la page
/// d'autorisation), « Connecter Figma » (sur le compte des nouvelles conversations) ; le reste par la page MCP.
struct AgentMCPFixes: View {
    @Environment(VigieStore.self) private var store
    let agent: AgentInfo
    /// Le lien vers la page MCP (pas dans le formulaire de lancement : la page changerait derrière lui).
    var pageLink = true

    var body: some View {
        let toFix = agent.mcpToFix
        ForEach(toFix) { mcp in
            if mcp.isMissing, let entry = mcp.libraryEntry {
                AsyncButton("Ajouter \(mcp.title)") {
                    if await entry.add(in: store) { await store.refreshAgents() }
                }
                .help("Ajoute le MCP officiel \(mcp.title) à tes comptes ; ton navigateur s'ouvre pour le connecter")
            } else if let name = mcp.connect, [.needsAuth, .failed].contains(mcp.mcpStatus) {
                AsyncButton("Connecter \(mcp.title)") {
                    await store.mcpConnect(name: name, accountId: store.agentsState?.account?.id, path: nil)
                    await store.refreshAgents()
                }
                .help("Ouvre ton navigateur pour connecter \(mcp.title) (\(name))")
            }
        }
        if pageLink, toFix.contains(where: { !Self.fixedHere($0) }) {
            Button("Régler dans MCP") { store.route = .mcp }
                .help("Ouvre la page MCP pour connecter ce qui manque")
        }
        if Self.needsCheck(agent) {
            if store.agentsChecking {
                HStack(spacing: 4) {
                    ProgressView()
                        .controlSize(.mini)
                    Text("Vérification…")
                        .foregroundStyle(.secondary)
                }
            } else {
                AsyncButton("Vérifier") { await store.checkAgentsMCP() }
                    .help("Demande tout de suite l'état de ses MCP (une minute au plus)")
            }
        }
    }

    /// Un MCP pas encore vérifié (moteur qui vient de redémarrer, MCP tout juste ajouté) : « Vérifier » le relève.
    nonisolated static func needsCheck(_ agent: AgentInfo) -> Bool {
        agent.mcp.contains { $0.mcpStatus == .unknown && !$0.isMissing }
    }

    nonisolated static func fixedHere(_ mcp: AgentMCP) -> Bool {
        (mcp.isMissing && mcp.libraryEntry != nil) || (mcp.connect != nil && [.needsAuth, .failed].contains(mcp.mcpStatus))
    }
}
