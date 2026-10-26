import SwiftUI

/// Ce qu'on ouvre dans la feuille d'édition.
enum MCPEditorRequest: Identifiable {
    case addUser
    case addProject(path: String?)
    case editUser(UserMCP)
    case editProject(path: String, server: ProjectServer)

    var id: String {
        switch self {
        case .addUser: "add-user"
        case .addProject(let path): "add-project-\(path ?? "")"
        case .editUser(let server): "edit-user-\(server.name)"
        case .editProject(let path, let server): "edit-project-\(path)-\(server.name)"
        }
    }
}

/// Une suppression à confirmer.
struct MCPRemoval: Equatable {
    let name: String
    let projectPath: String?
}

/// MCP : sur ton Mac, dans tes projets, connecteurs de compte. Chaque rangée porte ses raccourcis :
/// couper/rallumer, reconnecter, modifier.
struct MCPView: View {
    @Environment(VigieStore.self) private var store
    @State private var editor: MCPEditorRequest?
    @State private var showLibrary = false
    @State private var removal: MCPRemoval?
    @State private var confirmRemoval = false
    /// Projets dépliés (tous repliés au départ : on voit la liste des projets, on ouvre celui qui intéresse).
    @State private var expanded: Set<String> = []

    var body: some View {
        Group {
            if let mcp = store.mcp {
                content(mcp)
            } else {
                LoadingView()
            }
        }
        .navigationTitle("MCP")
        .navigationSubtitle(subtitle)
        .toolbar {
            ToolbarItem {
                AsyncButton("Vérifier maintenant", systemImage: "arrow.triangle.2.circlepath") { await store.mcpCheck() }
                .help("Vérifie tout de suite l'état des MCP dans chaque compte")
                .disabled(store.mcpChecking)
            }
            ToolbarItem {
                Button("Demander à Claude", systemImage: "bubble.left.and.text.bubble.right") {
                    MCPHelp.askClaude(about: nil, store: store)
                }
                .help("Copie une demande d'aide toute prête et ouvre VS Code : colle-la dans une conversation")
            }
            ToolbarItem {
                Menu {
                    Button("Bibliothèque de MCP officiels…", systemImage: "books.vertical") { showLibrary = true }
                    Button("À la main (avancé)…", systemImage: "slider.horizontal.3") { editor = .addUser }
                } label: {
                    Label("Ajouter un MCP", systemImage: "plus")
                }
                .help("Ajouter un MCP")
            }
        }
        .sheet(item: $editor) { request in
            MCPEditorSheet(request: request, projects: knownProjects)
        }
        .sheet(isPresented: $showLibrary) { MCPLibrarySheet() }
        .confirmationDialog(removal.map { "Supprimer « \($0.name) » ?" } ?? "", isPresented: $confirmRemoval,
                            titleVisibility: .visible, presenting: removal) { removal in
            Button("Supprimer", role: .destructive) {
                Task {
                    if let path = removal.projectPath {
                        _ = await store.mcpProject("remove", path: path, name: removal.name)
                    } else if store.mcp?.gateway?[removal.name] != nil {
                        await store.gateway("remove", name: removal.name)
                    } else {
                        _ = await store.mcpUser("remove", name: removal.name)
                    }
                }
            }
            Button("Annuler", role: .cancel) {}
        } message: { removal in
            Text(removal.projectPath == nil ? "Il sera retiré de tous tes comptes." : "Il sera retiré de ce projet (une copie de sauvegarde est gardée).")
        }
        .task(id: store.windowVisible) { await store.followMCP() }
    }

    private var subtitle: String {
        guard let mcp = store.mcp else { return "Les outils branchés à Claude" }
        var parts = [Fmt.count(mcp.user.count, "sur ton Mac", "sur ton Mac")]
        let projectCount = (mcp.projects + mcp.local).reduce(0) { $0 + $1.servers.count }
        if projectCount > 0 { parts.append(Fmt.count(projectCount, "dans tes projets", "dans tes projets")) }
        let allHealth = mcp.user.map(\.health) + (mcp.projects + mcp.local).flatMap { $0.servers.map(\.health) }
            + mcp.connectors.map(\.health)
        let toConnect = allHealth.count { $0.contains { $0.mcpStatus == .needsAuth } }
            + mcp.user.count { $0.health.isEmpty && $0.needsAuth == true }
        if toConnect > 0 { parts.append("\(toConnect) à connecter") }
        let failed = allHealth.count { $0.contains { $0.mcpStatus == .failed } }
        if failed > 0 { parts.append("\(failed) en échec") }
        if let checked = allHealth.compactMap(MCPStatusStyle.lastCheck).max() {
            parts.append("vérifié \(Fmt.ago(checked, now: store.now))")
        }
        return parts.joined(separator: " · ")
    }

    private func content(_ mcp: MCPState) -> some View {
        Form {
            Section {
                ForEach(mcp.user) { server in
                    UserMCPRow(server: server, accounts: store.accounts, projects: knownProjects,
                               edit: { editor = .editUser(server) },
                               remove: { ask(MCPRemoval(name: server.name, projectPath: nil)) })
                }
                if mcp.user.isEmpty { EmptyRow(text: "Aucun MCP sur ton Mac") }
            } header: {
                MCPSectionHeader(title: "MCP de ton Mac", text: "Dans toutes tes conversations, sur tous tes comptes Claude.")
            }

            Section {
                let projects = mcp.projects + mcp.local
                ForEach(projects) { project in
                    DisclosureGroup(isExpanded: Binding(
                        get: { expanded.contains(project.path) },
                        set: { open in if open { expanded.insert(project.path) } else { expanded.remove(project.path) } })) {
                        ForEach(project.servers) { server in
                            ProjectServerRow(project: project, server: server,
                                             edit: { editor = .editProject(path: project.path, server: server) },
                                             remove: { ask(MCPRemoval(name: server.name, projectPath: project.path)) })
                        }
                    } label: {
                        ProjectHeaderRow(project: project, isLocal: mcp.local.contains(project)) {
                            editor = .addProject(path: project.path)
                        }
                    }
                }
                if projects.isEmpty { EmptyRow(text: "Aucun projet de ~/Code n'a de MCP à lui") }
            } header: {
                MCPSectionHeader(title: "MCP des projets", text: "Seulement quand Claude travaille dans le dossier du projet (fichier .mcp.json).")
            }

            Section {
                @Bindable var store = store
                Toggle("Activés dans les nouvelles conversations", isOn: $store.connectorsDefaultOn)
                    .toggleStyle(.switch)
                ForEach(mcp.connectors.sorted { ($0.uses7d ?? 0) > ($1.uses7d ?? 0) }) { connector in
                    ConnectorRow(connector: connector, account: store.account(connector.accountId))
                }
                if mcp.connectors.isEmpty { EmptyRow(text: "Aucun MCP du compte utilisé pour l'instant") }
            } header: {
                MCPSectionHeader(title: "MCP du compte (claude.ai)",
                                 text: "Branchés à ton compte sur claude.ai (Gmail, Drive…), partagés par toutes ses conversations. Coupés par défaut, réglables par conversation.")
            }
        }
        .pageForm()
    }

    private func ask(_ value: MCPRemoval) {
        removal = value
        confirmRemoval = true
    }

    /// Projets connus : .mcp.json trouvés, réglages locaux, dossiers des conversations.
    private var knownProjects: [KnownProject] {
        var seen = Set<String>()
        var result: [KnownProject] = []
        let mcp = store.mcp
        for project in (mcp?.projects ?? []) + (mcp?.local ?? []) where seen.insert(project.path).inserted {
            result.append(KnownProject(path: project.path, name: project.displayName))
        }
        for conversation in store.conversations {
            guard let cwd = conversation.cwd, seen.insert(cwd).inserted else { continue }
            result.append(KnownProject(path: cwd, name: conversation.shortTitle))
        }
        return result
    }
}

struct KnownProject: Hashable, Identifiable {
    let path: String
    let name: String
    var id: String { path }
}

struct MCPSectionHeader: View {
    let title: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.headline)
                .foregroundStyle(.primary)
            Text(text)
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(.bottom, 2)
    }
}

/// « 3 657 en 7 j ».
struct UsesLabel: View {
    let count: Int?

    var body: some View {
        Text("\(Fmt.int(count)) en 7 j")
            .font(.caption)
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .help("Utilisations en 7 jours")
            .frame(minWidth: 62, alignment: .trailing)
            .opacity((count ?? 0) == 0 ? 0.6 : 1)
            .accessibilityLabel("\(Fmt.int(count)) utilisations en 7 jours")
    }
}

/// Un MCP de ton Mac : nom et provenance, utilisations, interrupteur, menu ; en dessous, son espace (par Vigie) ou
/// ce qui est à régler sur tes comptes.
struct UserMCPRow: View {
    @Environment(VigieStore.self) private var store
    let server: UserMCP
    let accounts: [Account]
    let projects: [KnownProject]
    let edit: () -> Void
    let remove: () -> Void

    var body: some View {
        let active = server.disabledIn.isEmpty
        // Par Vigie, l'état se lit sur la passerelle (une autorisation pour tous) ; en direct, compte par compte.
        let summary = gateway == nil ? MCPAccountSummary(accounts: accounts, health: server.health, declaredIn: server.accounts) : MCPAccountSummary(accounts: [], health: [])
        let notChecked = gateway == nil && server.health.isEmpty && server.needsAuth == true
        MCPRowLayout(service: server.service, name: server.name, subtitle: subtitle, dimmed: !active, uses: server.uses7d) {
            Toggle("Actif", isOn: everywhere)
                .toggleStyle(.switch)
                .labelsHidden()
                .controlSize(.small)
                .help(active ? "Actif partout · couper dans tes \(projects.count) projets" : "Coupé dans \(disabledNames) · réactiver partout")
            moreMenu
        } details: {
            if let gateway {
                GatewayLine(name: server.name, server: gateway)
            } else if !summary.isEmpty {
                MCPAccountIssues(name: server.name, summary: summary, path: nil) { ids in
                    Task { _ = await store.mcpUser("update", name: server.name, accounts: server.accounts + ids) }
                }
            } else if notChecked {
                MCPIssueLine(systemImage: "person.crop.circle.badge.exclamationmark", color: Theme.warn, text: "À connecter (pas encore vérifié sur tes comptes)") {
                    AsyncButton("Vérifier") { await store.mcpCheck() }
                        .controlSize(.small)
                }
            }
        }
    }

    /// Passe par la passerelle de Vigie : une autorisation pour tous les comptes.
    private var gateway: GatewayServer? { store.mcp?.gateway?[server.name] }

    /// En ligne, sans en-têtes à lui (clé d'API) : peut passer par Vigie.
    private var migratable: Bool {
        let host = server.target.flatMap { URL(string: $0)?.host() } ?? ""
        return server.type == "http" && (server.config?.headers?.isEmpty ?? true) && !MCPLibraryEntry.gatewayRefused.contains(host)
    }

    /// D'abord ce qui sort de l'ordinaire (« Coupé dans Boutique »), puis d'où il vient, en mots simples.
    private var subtitle: String {
        var parts: [String] = []
        if !server.disabledIn.isEmpty { parts.append("Coupé dans \(disabledNames)") }
        if let gateway {
            parts.append(MCPHelp.origin(type: "vigie", target: gateway.url))
        } else {
            parts.append(MCPHelp.origin(type: server.type, target: server.target))
            if server.differs == true { parts.append("réglé différemment selon le compte") }
        }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private var disabledNames: String {
        server.disabledIn.map { path in
            projects.first { $0.path == path }?.name ?? ProjectName.display((path as NSString).lastPathComponent, cwd: path)
        }
        .formatted(.list(type: .and).locale(Fmt.locale))
    }

    /// Allumé = actif dans tous tes projets ; couper = le couper dans chacun d'eux.
    private var everywhere: Binding<Bool> {
        Binding {
            server.disabledIn.isEmpty
        } set: { on in
            let paths = on ? server.disabledIn : projects.map(\.path).filter { !server.disabledIn.contains($0) }
            Task { await store.mcpSetEverywhere(name: server.name, disabled: !on, paths: paths) }
        }
    }

    private var moreMenu: some View {
        MCPMoreMenu {
            if !projects.isEmpty {
                Menu("Actif par projet") {
                    ForEach(projects) { project in
                        Toggle(project.name, isOn: projectBinding(project.path))
                    }
                }
            }
            if !missingAccounts.isEmpty {
                Button("Ajouter à tous les comptes", systemImage: "square.on.square") {
                    Task { _ = await store.mcpUser("update", name: server.name, accounts: accounts.map(\.id)) }
                }
            }
            if gateway != nil {
                Button("Ne plus passer par Vigie (une connexion par compte)", systemImage: "arrow.uturn.backward") {
                    Task { await store.gateway("restore", name: server.name) }
                }
            } else if migratable {
                Button("Passer par Vigie (une seule connexion pour tous tes comptes)", systemImage: "arrow.triangle.merge") {
                    Task { await store.gateway("migrate", name: server.name) }
                }
            }
            if gateway == nil && (server.type == "http" || server.type == "sse") {
                Menu("Reconnecter sur un compte") {
                    ForEach(accounts.filter { server.accounts.contains($0.id) && $0.isConnected && !$0.isCodex }) { account in
                        Button(account.displayName) {
                            Task { await store.mcpConnect(name: server.name, accountId: account.id, path: nil, force: true) }
                        }
                    }
                }
            }
            Button("Modifier", systemImage: "pencil", action: edit)
            Button("Demander à Claude", systemImage: "bubble.left.and.text.bubble.right") {
                MCPHelp.askClaude(about: server.name, store: store)
            }
            Divider()
            Button("Supprimer", systemImage: "trash", role: .destructive, action: remove)
        }
    }

    private func projectBinding(_ path: String) -> Binding<Bool> {
        Binding {
            !server.disabledIn.contains(path)
        } set: { on in
            Task { await store.mcpUserDisable(path: path, name: server.name, disabled: !on) }
        }
    }

    private var missingAccounts: [Account] {
        accounts.filter { !server.accounts.contains($0.id) }
    }
}

struct ProjectHeaderRow: View {
    let project: ProjectMCP
    let isLocal: Bool
    let add: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "folder")
                .foregroundStyle(.secondary)
            Text(project.displayName).bold()
            Text(Fmt.count(project.servers.count, "MCP", "MCP"))
                .foregroundStyle(.secondary)
                .monospacedDigit()
            Text(isLocal ? "\(Fmt.shortPath(project.path)) · rien que pour toi" : Fmt.shortPath(project.path))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            Button("Ajouter ici", systemImage: "plus", action: add)
                .buttonStyle(.borderless)
                .labelStyle(.iconOnly)
                .help("Ajouter un MCP à ce projet")
        }
        .padding(.vertical, 2)
        .contentShape(.rect)
    }
}

/// Un MCP d'un projet : interrupteur pour ce projet, reconnecter, modifier.
struct ProjectServerRow: View {
    @Environment(VigieStore.self) private var store
    let project: ProjectMCP
    let server: ProjectServer
    let edit: () -> Void
    let remove: () -> Void

    var body: some View {
        let enabled = !(server.disabled ?? false)
        let summary = MCPAccountSummary(accounts: store.accounts, health: server.health)
        let subtitle = [enabled ? nil : "Coupé dans ce projet", MCPHelp.origin(type: server.type, target: server.target)]
            .compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
        MCPRowLayout(service: server.service, name: server.name, subtitle: subtitle, dimmed: !enabled, uses: server.uses7d) {
            Toggle("Actif dans ce projet", isOn: enabledBinding(enabled))
                .toggleStyle(.switch)
                .labelsHidden()
                .controlSize(.small)
                .help(enabled ? "Couper pour ce projet" : "Réactiver pour ce projet")
            MCPMoreMenu {
                Button("Modifier", systemImage: "pencil", action: edit)
                Button("Demander à Claude", systemImage: "bubble.left.and.text.bubble.right") {
                    MCPHelp.askClaude(about: server.name, store: store)
                }
                Divider()
                Button("Supprimer", systemImage: "trash", role: .destructive, action: remove)
            }
        } details: {
            if !summary.isEmpty {
                MCPAccountIssues(name: server.name, summary: summary, path: project.path)
            }
        }
        .padding(.leading, 16)
    }

    private func enabledBinding(_ enabled: Bool) -> Binding<Bool> {
        Binding {
            enabled
        } set: { on in
            Task { await store.mcpDisable(path: project.path, name: server.name, disabled: !on) }
        }
    }
}

/// Un MCP du compte (claude.ai) : sur un compte, ou sur tous ; pas d'interrupteur ici (réglage par conversation).
struct ConnectorRow: View {
    @Environment(VigieStore.self) private var store
    let connector: Connector
    let account: Account?

    var body: some View {
        let summary = MCPAccountSummary(accounts: store.accounts, health: connector.health, only: connector.accountId.map { [$0] })
        MCPRowLayout(service: connector.service, name: connector.name,
                     subtitle: account.map { "Sur \($0.displayName)" } ?? "Sur tes comptes", uses: connector.uses7d) {
            EmptyView()
        } details: {
            if !summary.isEmpty {
                MCPAccountIssues(name: connector.name, summary: summary)
            }
        }
    }
}

/// Aides vers Claude Code : message préparé, reconnexion par « /mcp ».
@MainActor
enum MCPHelp {
    static func askClaude(about name: String?, store: VigieStore) {
        var lines: [String] = []
        if let name {
            lines.append("Aide-moi à régler le serveur MCP « \(name) » dans Claude Code.")
        } else {
            lines.append("Aide-moi à régler mes serveurs MCP dans Claude Code.")
        }
        lines.append("Regarde d'abord ce qui est branché (claude mcp list, ~/.claude.json, les .mcp.json de ~/Code).")
        lines.append("Dis-moi en une phrase ce que tu proposes avant de modifier quoi que ce soit, et n'affiche jamais de clé ni de jeton.")
        SystemActions.copy(lines.joined(separator: "\n"))
        SystemActions.activateVSCode()
        store.show(info: "Message copié : colle-le dans une conversation Claude")
    }

    /// Reconnecter : « /mcp » est copié, VS Code s'ouvre (sur le projet s'il y en a un), une consigne d'une ligne.
    static func reconnect(_ name: String, path: String?, store: VigieStore) {
        SystemActions.copy("/mcp")
        if let path {
            SystemActions.openInVSCode(path: path)
        } else {
            SystemActions.activateVSCode()
        }
        store.show(info: "« /mcp » copié : colle-le dans Claude, choisis « \(name) », puis « Reconnect »")
    }

    /// D'où vient un MCP, en mots simples : « Par Vigie · mcp.webflow.com », « En ligne · mcp.figma.com »,
    /// « Programme · python3 ~/Code/… ».
    static func origin(type: String?, target: String?) -> String {
        let place = shortTarget(target)
        let kind = switch type {
        case "vigie": "Par Vigie"
        case "http", "sse": "En ligne"
        default: "Programme"
        }
        return place.isEmpty ? kind : "\(kind) · \(place)"
    }

    /// « https://mcp.figma.com/mcp » → « mcp.figma.com » ; une commande reste telle quelle.
    static func shortTarget(_ target: String?) -> String {
        guard let target, !target.isEmpty else { return "" }
        if let url = URL(string: target), let host = url.host(), url.scheme?.hasPrefix("http") == true {
            return host
        }
        return target
    }
}
