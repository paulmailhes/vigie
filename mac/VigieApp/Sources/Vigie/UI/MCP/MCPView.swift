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

/// MCP : d'abord ce qui est à régler (une ligne par MCP et par compte, avec son geste), puis les MCP de ton Mac, de
/// tes projets et de ton compte claude.ai. Chaque rangée porte ses raccourcis : couper ou réactiver, reconnecter,
/// modifier.
struct MCPView: View {
    @Environment(VigieStore.self) private var store
    @State private var editor: MCPEditorRequest?
    @State private var showLibrary = false
    @State private var removal: MCPRemoval?
    @State private var confirmRemoval = false
    /// Projets ouverts ou refermés à la main. Au départ, seuls ceux qui ont un MCP à régler sont ouverts (on voit la
    /// liste des projets, on ouvre celui qui intéresse).
    @State private var opened: Set<String> = []
    @State private var closed: Set<String> = []

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
                AsyncButton("Vérifier maintenant", systemImage: "arrow.clockwise") { await store.mcpCheck() }
                    .help(checkHelp)
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
                        .labelStyle(.titleAndIcon)
                }
                .help("Depuis la bibliothèque des MCP officiels, ou à la main")
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

    /// Ce qui est à régler, une ligne par MCP et par compte.
    private var fixes: [MCPFix] {
        store.mcp.map { MCPFix.all(in: $0, accounts: store.accounts) } ?? []
    }

    /// Le dernier contrôle de l'état des MCP, tous comptes confondus.
    private var lastCheck: Date? {
        guard let mcp = store.mcp else { return nil }
        let health = mcp.user.map(\.health) + (mcp.projects + mcp.local).flatMap { $0.servers.map(\.health) }
            + mcp.connectors.map(\.health)
        return health.compactMap(MCPStatusStyle.lastCheck).max()
    }

    /// « 7 sur ton Mac · 5 dans tes projets · 3 à régler » ; rien à régler : la fraîcheur à la place.
    private var subtitle: String {
        guard let mcp = store.mcp else { return "" }
        let projectCount = (mcp.projects + mcp.local).reduce(0) { $0 + $1.servers.count }
        let toFix = fixes.count
        return InfoLine.text([
            Fmt.count(mcp.user.count, "sur ton Mac", "sur ton Mac"),
            projectCount > 0 ? Fmt.count(projectCount, "dans tes projets", "dans tes projets") : nil,
            toFix > 0 ? "\(toFix) à régler" : lastCheck.map { "mis à jour \(Fmt.ago($0, now: store.now))" },
        ])
    }

    private var checkHelp: String {
        let base = "Vérifie tout de suite l'état des MCP dans chaque compte"
        guard let lastCheck else { return base }
        return "\(base) · \(Freshness.text(date: lastCheck, now: store.now))"
    }

    private func content(_ mcp: MCPState) -> some View {
        let fixes = self.fixes
        let projects = mcp.projects + mcp.local
        return Form {
            if !fixes.isEmpty {
                Section {
                    ForEach(fixes) { fix in
                        MCPFixRow(fix: fix)
                    }
                } header: {
                    SectionHeader("À régler", count: fixes.count,
                                  note: lastCheck.map { Freshness.text(prefix: "État mis à jour", date: $0, now: store.now) },
                                  inset: 0)
                }
            }

            Section {
                ForEach(mcp.user) { server in
                    UserMCPRow(server: server, accounts: store.accounts, projects: knownProjects,
                               edit: { editor = .editUser(server) },
                               remove: { ask(MCPRemoval(name: server.name, projectPath: nil)) })
                }
                if mcp.user.isEmpty { EmptyRow(text: "Aucun MCP sur ton Mac") }
            } header: {
                SectionHeader(Theme.title(for: .mac), count: mcp.user.count,
                              note: "Dans toutes tes conversations, sur tous tes comptes Claude.", inset: 0)
            }

            Section {
                ForEach(projects) { project in
                    let projectFixes = fixes.filter { $0.path == project.path }
                    DisclosureGroup(isExpanded: expandedBinding(project.path, hasFixes: !projectFixes.isEmpty)) {
                        ForEach(project.servers) { server in
                            ProjectServerRow(project: project, server: server,
                                             edit: { editor = .editProject(path: project.path, server: server) },
                                             remove: { ask(MCPRemoval(name: server.name, projectPath: project.path)) })
                        }
                    } label: {
                        ProjectHeaderRow(project: project, isLocal: mcp.local.contains(project), fixes: projectFixes) {
                            editor = .addProject(path: project.path)
                        }
                    }
                }
                if projects.isEmpty { EmptyRow(text: "Aucun projet de ~/Code n'a de MCP à lui") }
            } header: {
                SectionHeader("MCP des projets", count: projects.reduce(0) { $0 + $1.servers.count },
                              note: "Seulement quand Claude travaille dans le dossier du projet.", inset: 0)
                    .help("Déclarés dans le fichier .mcp.json du projet")
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
                SectionHeader(Theme.title(for: .connector), count: mcp.connectors.count,
                              note: "Branchés à ton compte sur claude.ai (Gmail, Drive…), partagés par toutes ses conversations. Coupés par défaut, réglables par conversation.",
                              inset: 0)
            }
        }
        .pageForm()
    }

    /// Un projet est ouvert s'il a été ouvert à la main, ou s'il a un MCP à régler et n'a pas été refermé.
    private func expandedBinding(_ path: String, hasFixes: Bool) -> Binding<Bool> {
        Binding {
            opened.contains(path) || (hasFixes && !closed.contains(path))
        } set: { open in
            if open {
                opened.insert(path)
                closed.remove(path)
            } else {
                opened.remove(path)
                closed.insert(path)
            }
        }
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

/// « 3 657 appels en 7 j » sur la page MCP ; « 350 appels ici » dans une conversation.
struct UsesLabel: View {
    let count: Int?
    /// « en 7 j » sur la page MCP ; « ici » dans une conversation (ses appels, depuis son début).
    var here = false

    var body: some View {
        Text(here ? "\(Fmt.count(count ?? 0, "appel")) ici" : "\(Fmt.count(count ?? 0, "appel")) en 7 j")
            .font(here ? .caption : .callout)
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .help(here ? "Appels dans cette conversation" : "Appels de ce MCP ces 7 derniers jours")
            .frame(minWidth: 62, alignment: .trailing)
            .opacity((count ?? 0) == 0 ? 0.6 : 1)
            .accessibilityLabel(here ? "\(Fmt.count(count ?? 0, "appel")) dans cette conversation" : "\(Fmt.count(count ?? 0, "appel")) en 7 jours")
    }
}

/// Un MCP de ton Mac : nom et provenance, utilisations, interrupteur, menu ; en dessous, son espace (par Vigie) ou
/// les remarques sur tes comptes. Ce qui demande un geste est dans « À régler » (une puce le signale ici).
struct UserMCPRow: View {
    @Environment(VigieStore.self) private var store
    let server: UserMCP
    let accounts: [Account]
    let projects: [KnownProject]
    let edit: () -> Void
    let remove: () -> Void
    @State private var confirmSwitch = false

    var body: some View {
        let active = server.disabledIn.isEmpty
        // Par Vigie, l'état se lit sur la passerelle (une autorisation pour tous) ; en direct, compte par compte.
        let summary = gateway == nil ? MCPAccountSummary(accounts: accounts, health: server.health, declaredIn: server.accounts) : MCPAccountSummary(accounts: [], health: [])
        let switchCount = server.accounts.count
        MCPRowLayout(service: server.service, name: server.name, subtitle: subtitle, dimmed: !active,
                     status: status(summary), uses: server.uses7d) {
            Toggle("Activer \(server.name)", isOn: everywhere)
                .toggleStyle(.switch)
                .labelsHidden()
                .controlSize(.small)
                .help(active ? "Actif partout · couper dans tes \(projects.count) projets" : "Coupé dans \(disabledNames) · réactiver partout")
            moreMenu
        } details: {
            if let gateway {
                // à connecter : la ligne est dans « À régler » (la puce le signale ici)
                if !GatewayLine.needsFix(gateway) {
                    GatewayLine(name: server.name, server: gateway, mode: .status)
                }
            } else if summary.hasNotes {
                MCPAccountIssues(name: server.name, summary: summary) { ids in
                    Task { _ = await store.mcpUser("update", name: server.name, accounts: server.accounts + ids) }
                }
            }
        }
        .confirmationDialog("Reconnecter « \(server.name) » partout avec un autre compte ?", isPresented: $confirmSwitch) {
            Button("Déconnecter et reconnecter") { Task { await store.mcpConnectEverywhere(name: server.name, force: true) } }
        } message: {
            Text("Il est déconnecté de \(switchCount == 1 ? "ton compte Claude" : "tes \(switchCount) comptes Claude"), puis ton navigateur s'ouvre une fois par compte pour le reconnecter. Avant : sur le site du service (figma.com…), connecte-toi avec le nouveau compte — c'est lui qui sera autorisé. Une conversation déjà ouverte le reprend après « Reconnect » dans son panneau MCP.")
        }
    }

    /// La puce à côté du nom : la passerelle à connecter, sinon le plus grave sur les comptes, sinon pas vérifié.
    private func status(_ summary: MCPAccountSummary) -> MCPRowStatus? {
        if let gateway {
            guard GatewayLine.needsFix(gateway) else { return nil }
            return MCPRowStatus(text: gateway.profiles.isEmpty ? "à connecter" : "à reconnecter", tone: .warn)
        }
        if let status = summary.status { return status }
        if server.health.isEmpty && server.needsAuth == true { return MCPRowStatus(text: "à vérifier", tone: .warn) }
        return nil
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

    /// Activé = actif dans tous tes projets ; couper = le couper dans chacun d'eux.
    private var everywhere: Binding<Bool> {
        Binding {
            server.disabledIn.isEmpty
        } set: { on in
            let paths = on ? server.disabledIn : projects.map(\.path).filter { !server.disabledIn.contains($0) }
            Task { await store.mcpSetEverywhere(name: server.name, disabled: !on, paths: paths) }
        }
    }

    private var moreMenu: some View {
        MoreMenu(name: server.name) {
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
                Button("Reconnecter partout avec un autre compte…", systemImage: "person.2.badge.gearshape") { confirmSwitch = true }
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

/// L'en-tête d'un projet : son nom, ses MCP, ce qui est à régler (en puce), son dossier, « Ajouter ici ».
struct ProjectHeaderRow: View {
    let project: ProjectMCP
    let isLocal: Bool
    /// Ce qui est à régler dans ce projet (détaillé dans « À régler »).
    var fixes: [MCPFix] = []
    let add: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "folder")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            // le nom et le nombre passent avant le dossier, qui se coupe au milieu le premier
            Text(project.displayName)
                .textRole(.item)
                .lineLimit(1)
                .layoutPriority(2)
            Text(Fmt.count(project.servers.count, "MCP", "MCP"))
                .foregroundStyle(.secondary)
                .monospacedDigit()
                .fixedSize()
            if let chip { chip }
            CodeLine(isLocal ? "\(Fmt.shortPath(project.path)) · rien que pour toi" : Fmt.shortPath(project.path))
            Spacer(minLength: 8)
            IconButton("Ajouter un MCP à ce projet", systemImage: "plus") { add() }
        }
        .contentShape(.rect)
    }

    /// « 1 en échec » (rouge) d'abord, sinon « 2 à régler » (orange) : un projet replié ne cache plus rien.
    private var chip: Chip? {
        let failed = fixes.count { $0.kind == .failed }
        if failed > 0 { return Chip("\(failed) en échec", tone: .alert) }
        if !fixes.isEmpty { return Chip("\(fixes.count) à régler", tone: .warn) }
        return nil
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
        MCPRowLayout(service: server.service, name: server.name, subtitle: subtitle, dimmed: !enabled,
                     status: summary.status, uses: server.uses7d) {
            Toggle("Activer \(server.name) dans ce projet", isOn: enabledBinding(enabled))
                .toggleStyle(.switch)
                .labelsHidden()
                .controlSize(.small)
                .help(enabled ? "Couper pour ce projet" : "Réactiver pour ce projet")
            MoreMenu(name: server.name) {
                Button("Modifier", systemImage: "pencil", action: edit)
                Button("Demander à Claude", systemImage: "bubble.left.and.text.bubble.right") {
                    MCPHelp.askClaude(about: server.name, store: store)
                }
                Divider()
                Button("Supprimer", systemImage: "trash", role: .destructive, action: remove)
            }
        } details: {
            if summary.hasNotes {
                MCPAccountIssues(name: server.name, summary: summary)
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
                     subtitle: account.map { "Sur \($0.displayName)" } ?? "Sur tes comptes",
                     status: summary.status, uses: connector.uses7d) {
            EmptyView()
        } details: {
            if summary.hasNotes {
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
