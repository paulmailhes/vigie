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
                Button("Vérifier maintenant", systemImage: "arrow.triangle.2.circlepath") {
                    Task { await store.mcpCheck() }
                }
                .help("Vérifie tout de suite l'état des MCP dans chaque compte")
                .disabled(store.mcpChecking)
            }
            ToolbarItem {
                Button("Demander à Claude", systemImage: "bubble.left.and.text.bubble.right") {
                    MCPHelp.askClaude(about: nil, store: store)
                }
                .help("Copie un message préparé et ouvre VS Code")
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
                    } else {
                        _ = await store.mcpUser("remove", name: removal.name)
                    }
                }
            }
            Button("Annuler", role: .cancel) {}
        } message: { removal in
            Text(removal.projectPath == nil ? "Il sera retiré de tous tes comptes." : "Il sera retiré du .mcp.json du projet (sauvegarde gardée).")
        }
        .task { await store.followMCP() }
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
            parts.append("vérifié \(Fmt.when(checked, now: store.now))")
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
                MCPSectionHeader(title: "MCP de ce Mac", text: "Dans toutes tes conversations, sur tous tes comptes Claude.")
            }

            Section {
                let projects = mcp.projects + mcp.local
                ForEach(projects) { project in
                    ProjectHeaderRow(project: project, isLocal: mcp.local.contains(project)) {
                        editor = .addProject(path: project.path)
                    }
                    ForEach(project.servers) { server in
                        ProjectServerRow(project: project, server: server,
                                         edit: { editor = .editProject(path: project.path, server: server) },
                                         remove: { ask(MCPRemoval(name: server.name, projectPath: project.path)) })
                    }
                }
                if projects.isEmpty { EmptyRow(text: "Aucun .mcp.json dans ~/Code") }
            } header: {
                MCPSectionHeader(title: "MCP des projets", text: "Seulement quand Claude travaille dans ce dossier (fichier .mcp.json).")
            }

            Section {
                @Bindable var store = store
                Toggle("Activés dans les nouvelles conversations", isOn: $store.connectorsDefaultOn)
                    .toggleStyle(.switch)
                ForEach(mcp.connectors.sorted { ($0.uses7d ?? 0) > ($1.uses7d ?? 0) }) { connector in
                    ConnectorRow(connector: connector, account: store.account(connector.accountId))
                }
                if mcp.connectors.isEmpty { EmptyRow(text: "Aucun MCP du compte vu") }
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
            .frame(minWidth: 62, alignment: .trailing)
            .opacity((count ?? 0) == 0 ? 0.6 : 1)
            .accessibilityLabel("\(Fmt.int(count)) utilisations en 7 jours")
    }
}

/// Un MCP de ton Mac : nom, type et adresse, comptes, utilisations, raccourcis.
struct UserMCPRow: View {
    @Environment(VigieStore.self) private var store
    let server: UserMCP
    let accounts: [Account]
    let projects: [KnownProject]
    let edit: () -> Void
    let remove: () -> Void

    var body: some View {
        let active = server.disabledIn.isEmpty
        HStack(spacing: 10) {
            ServiceGlyph(service: server.service, name: server.name)
                .opacity(active ? 1 : Theme.dim)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(server.name)
                        .foregroundStyle(active ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                    if server.health.isEmpty && server.needsAuth == true {
                        Pill(text: "À connecter", alert: true)
                    }
                }
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .opacity(active ? 1 : Theme.dim)
            Spacer(minLength: 8)
            MCPConnectEverywhereButton(name: server.name, health: server.health)
            UsesLabel(count: server.uses7d)
            Toggle("Actif", isOn: everywhere)
                .toggleStyle(.switch)
                .labelsHidden()
                .controlSize(.small)
                .help(active ? "Actif partout · couper dans tes \(projects.count) projets" : "Coupé dans \(disabledNames) · rallumer partout")
            moreMenu
            MCPAccountCells(name: server.name, health: server.health, declaredIn: server.accounts, path: nil) { id in
                Task { _ = await store.mcpUser("update", name: server.name, accounts: [id]) }
            }
        }
        .padding(.vertical, 2)
    }

    /// D'abord ce qui sort de l'ordinaire (« coupé dans Boutique »), puis le type et l'adresse ; « absent » se lit
    /// dans les cases des comptes.
    private var subtitle: String {
        var parts: [String] = []
        if !server.disabledIn.isEmpty { parts.append("coupé dans \(disabledNames)") }
        if server.differs == true { parts.append("diffère selon le compte") }
        parts.append(server.type ?? "stdio")
        parts.append(MCPHelp.shortTarget(server.target))
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
        Menu {
            if !projects.isEmpty {
                Menu("Actif par projet") {
                    ForEach(projects) { project in
                        Toggle(project.name, isOn: projectBinding(project.path))
                    }
                }
            }
            if !missingAccounts.isEmpty {
                Button("Mettre dans tous les comptes", systemImage: "square.on.square") {
                    Task { _ = await store.mcpUser("update", name: server.name, accounts: accounts.map(\.id)) }
                }
            }
            if server.type == "http" || server.type == "sse" {
                Menu("Refaire l'autorisation") {
                    ForEach(accounts.filter { server.accounts.contains($0.id) && $0.isConnected }) { account in
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
        } label: {
            Label("Plus", systemImage: "ellipsis")
                .labelStyle(.iconOnly)
        }
        .menuStyle(.button)
        .buttonStyle(.borderless)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Plus d'actions")
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
            Text(isLocal ? "\(Fmt.shortPath(project.path)) · réglage local" : Fmt.shortPath(project.path))
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
        .padding(.top, 4)
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
        HStack(spacing: 10) {
            ServiceGlyph(service: server.service, name: server.name)
                .opacity(enabled ? 1 : Theme.dim)
            VStack(alignment: .leading, spacing: 2) {
                Text(server.name)
                    .foregroundStyle(enabled ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                Text([enabled ? nil : "coupé ici", server.type ?? "stdio", MCPHelp.shortTarget(server.target)]
                    .compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .opacity(enabled ? 1 : Theme.dim)
            Spacer(minLength: 8)
            UsesLabel(count: server.uses7d)
            Toggle("Actif dans ce projet", isOn: enabledBinding(enabled))
                .toggleStyle(.switch)
                .labelsHidden()
                .controlSize(.small)
                .help(enabled ? "Couper pour ce projet" : "Rallumer pour ce projet")
            Menu {
                Button("Modifier", systemImage: "pencil", action: edit)
                Button("Demander à Claude", systemImage: "bubble.left.and.text.bubble.right") {
                    MCPHelp.askClaude(about: server.name, store: store)
                }
                Divider()
                Button("Supprimer", systemImage: "trash", role: .destructive, action: remove)
            } label: {
                Label("Plus", systemImage: "ellipsis")
                    .labelStyle(.iconOnly)
            }
            .menuStyle(.button)
            .buttonStyle(.borderless)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Plus d'actions")
            MCPAccountCells(name: server.name, health: server.health, path: project.path)
        }
        .padding(.leading, 16)
        .padding(.vertical, 2)
    }

    private func enabledBinding(_ enabled: Bool) -> Binding<Bool> {
        Binding {
            enabled
        } set: { on in
            Task { await store.mcpDisable(path: project.path, name: server.name, disabled: !on) }
        }
    }
}

struct ConnectorRow: View {
    let connector: Connector
    let account: Account?

    var body: some View {
        HStack(spacing: 10) {
            ServiceGlyph(service: connector.service, name: connector.name)
            Text(connector.name)
            Spacer(minLength: 8)
            UsesLabel(count: connector.uses7d)
            if let account { Text(account.displayName).font(.caption).foregroundStyle(.secondary) }
            MCPAccountCells(name: connector.name, health: connector.health, only: connector.accountId.map { [$0] })
        }
        .padding(.vertical, 1)
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
        store.show(info: "« /mcp » copié : colle-le dans Claude, choisis « \(name) », puis Reconnecter")
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
