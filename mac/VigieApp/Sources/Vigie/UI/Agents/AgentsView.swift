import AppKit
import SwiftUI

/// Agents : les recettes prêtes à lancer, une par dossier (<dossier des agents>/<id>/AGENT.md, ou un dossier d'une
/// bibliothèque). Une rangée par agent : ce qu'il fait, d'où il vient, les MCP dont il a besoin et leur état, et
/// « Lancer… » qui ouvre son formulaire. En dessous, les bibliothèques : des dépôts git tenus à jour par Vigie.
struct AgentsView: View {
    @Environment(VigieStore.self) private var store
    @State private var launching: AgentInfo?
    @State private var addingLibrary = false
    /// La bibliothèque à retirer, en attente de confirmation.
    @State private var removal: AgentLibraryInfo?

    var body: some View {
        Group {
            if let state = store.agentsState {
                if state.agents.isEmpty && (state.libraries ?? []).isEmpty {
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
                    .help("Relire le dossier des agents (un AGENT.md ajouté ou modifié)")
            }
            ToolbarItem {
                Button("Ouvrir le dossier des agents", systemImage: "folder") { openFolder() }
                    .help("Ouvre le dossier des agents dans le Finder : un dossier par agent, avec son AGENT.md")
                    .disabled(store.agentsState?.dir == nil)
            }
        }
        .sheet(item: $launching) { agent in
            AgentLaunchSheet(agent: agent)
        }
        .sheet(isPresented: $addingLibrary) { AgentLibraryAddSheet() }
        .confirmationDialog(removal.map { "Retirer la bibliothèque « \($0.displayName) » ?" } ?? "",
                            isPresented: Binding { removal != nil } set: { if !$0 { removal = nil } },
                            titleVisibility: .visible, presenting: removal) { library in
            Button("Retirer", role: .destructive) {
                Task { await store.removeAgentLibrary(library) }
            }
            Button("Annuler", role: .cancel) {}
        } message: { library in
            Text(removalMessage(library))
        }
        .task(id: store.windowVisible) { await store.followAgents() }
    }

    private func content(_ state: AgentsPage) -> some View {
        Form {
            Section {
                ForEach(state.agents) { agent in
                    AgentRecipeRow(agent: agent) { launching = agent }
                }
                if state.agents.isEmpty { EmptyRow(text: "Aucun agent pour l'instant") }
            } header: {
                MCPSectionHeader(title: "Tes agents",
                                 text: "Chacun prépare le dossier du projet, puis ouvre une conversation Claude Code qui suit sa consigne, dans VS Code ou dans l'app Claude.")
            } footer: {
                footer(state)
            }

            // moteur plus ancien, sans bibliothèques : rien
            if let libraries = state.libraries {
                Section {
                    ForEach(libraries) { library in
                        AgentLibraryRow(library: library, count: state.agentCount(of: library)) { removal = library }
                    }
                    if libraries.isEmpty { EmptyRow(text: "Aucune bibliothèque pour l'instant") }
                } header: {
                    MCPSectionHeader(title: "Bibliothèques",
                                     text: "Des agents partagés par un dépôt git. Vigie les récupère et les tient à jour toutes les heures.")
                } footer: {
                    Button("Ajouter une bibliothèque…", systemImage: "plus") { addingLibrary = true }
                        .glassButton()
                        .help("Colle l'adresse d'un dépôt git : un dossier par agent, avec son AGENT.md")
                        .padding(.top, 4)
                }
            }
        }
        .pageForm()
    }

    /// « Ses 3 agents disparaissent de Vigie. … »
    private func removalMessage(_ library: AgentLibraryInfo) -> String {
        let count = store.agentsState?.agentCount(of: library) ?? 0
        let agents = count == 0 ? "" : count == 1 ? "Son agent disparaît de Vigie. " : "Ses \(Fmt.int(count)) agents disparaissent de Vigie. "
        return agents + "Le dépôt et tes projets ne sont pas touchés : tu pourras l'ajouter de nouveau."
    }

    private func footer(_ state: AgentsPage) -> some View {
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
            if let dir = state.dir {
                Label("Pour en ajouter un : un dossier avec un fichier AGENT.md dans \(Fmt.shortPath(dir)).", systemImage: "folder")
            }
        }
        .font(.callout)
        .foregroundStyle(.secondary)
        .padding(.top, 4)
    }

    private func empty(_ state: AgentsPage) -> some View {
        ContentUnavailableView {
            Label("Aucun agent pour l'instant", systemImage: Icon.recipe)
        } description: {
            Text("Un agent est un dossier avec un fichier AGENT.md, rangé dans le dossier des agents.")
            if let dir = state.dir {
                Text(Fmt.shortPath(dir))
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
            }
        } actions: {
            Button("Ouvrir le dossier des agents", systemImage: "folder") { openFolder() }
                .glassButton(.primary)
                .disabled(state.dir == nil)
            if state.libraries != nil {
                Button("Ajouter une bibliothèque…", systemImage: "plus") { addingLibrary = true }
                    .glassButton()
                    .help("Colle l'adresse d'un dépôt git : un dossier par agent, avec son AGENT.md")
            }
        }
    }

    /// Le moteur crée le dossier s'il manque (à chaque lecture de la liste) : absent, il a été retiré entre-temps.
    private func openFolder() {
        guard let dir = store.agentsState?.dir else { return }
        guard FileManager.default.fileExists(atPath: dir) else {
            store.show(error: "Dossier des agents introuvable : clique sur « Actualiser », Vigie le recrée")
            return
        }
        NSWorkspace.shared.open(URL(filePath: dir, directoryHint: .isDirectory))
    }
}

/// Un agent : icône, nom, ce qu'il fait, sa bibliothèque (rien pour un agent local), ses MCP et leur état,
/// « Lancer… ». Son AGENT.md est illisible : la raison en rouge, et rien à lancer.
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
                    if let library = agent.libraryName {
                        Label("Bibliothèque \(library)", systemImage: Icon.library)
                            .labelStyle(CompactLabelStyle())
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.top, 1)
                            .help("Vient d'une bibliothèque : Vigie le tient à jour avec son dépôt")
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
                        if !agent.mcpToFix.isEmpty {
                            Button("Régler dans MCP") { store.route = .mcp }
                                .buttonStyle(.link)
                                .font(.caption)
                                .padding(.top, 3)
                                .help("Ouvre la page MCP pour connecter ce qui manque")
                        }
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

/// Un MCP nécessaire : son nom et son état en toutes lettres ; la couleur seulement pour ce qui est à régler.
struct AgentMCPBadge: View {
    let mcp: AgentMCP

    var body: some View {
        let status = mcp.mcpStatus
        HStack(spacing: 4) {
            Image(systemName: MCPStatusStyle.symbol(status))
                .imageScale(.small)
                .foregroundStyle(MCPStatusStyle.color(status))
            Text(mcp.name)
                .fontWeight(.medium)
            Text(MCPStatusStyle.label(status))
                .foregroundStyle(MCPStatusStyle.color(status))
        }
        .font(.caption)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(.quaternary, in: .capsule)
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(mcp.name) : \(MCPStatusStyle.label(status))")
    }
}
