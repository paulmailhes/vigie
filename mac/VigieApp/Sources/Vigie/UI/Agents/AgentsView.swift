import SwiftUI

/// Agents : les recettes prêtes à lancer, livrées avec Vigie (agents/<id>/AGENT.md, remplacés à chaque mise à jour),
/// et leurs réglages. Une rangée par agent : ce qu'il fait, les MCP dont il a besoin et leur état, et « Lancer… » qui
/// ouvre son formulaire. Ce qu'un agent a fait ne s'affiche pas ici : son rapport se lit sur la page de sa
/// conversation (tuile « Agent Vigie », panneau Rapport).
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
        .navigationSubtitle(subtitle)
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

    /// « 2 agents » : un état chiffré.
    private var subtitle: String {
        guard let state = store.agentsState else { return "" }
        return Fmt.count(state.agents.count, "agent")
    }

    private func content(_ state: AgentLibrary) -> some View {
        Form {
            Section {
                ForEach(state.agents) { agent in
                    AgentRecipeRow(agent: agent) { launching = agent }
                }
            } header: {
                SectionHeader("Prêts à lancer", count: state.agents.count,
                              note: "Le rapport de chaque agent se lit sur la page de la conversation qu'il ouvre.",
                              inset: PageMetrics.formHeaderInset)
            } footer: {
                footer(state)
            }
        }
        .pageForm()
    }

    private func footer(_ state: AgentLibrary) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let account = AgentAccountWarning.launchAccount(store) {
                HStack(spacing: 6) {
                    Label("Un agent lancé partira sur le compte \(account.name) (celui des nouvelles conversations).",
                          systemImage: Icon.account)
                    Button("Changer") { store.showAccounts(account.id) }
                        .buttonStyle(.link)
                        .help("Le compte des nouvelles conversations se choisit sur la page Comptes")
                }
                AgentAccountWarning(accountID: account.id)
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

/// Le compte de départ d'un agent est presque plein (session ou semaine à 90 % ou plus) : l'avertir avant de lancer,
/// avec le compte qui a le plus de marge et « Mettre les nouvelles conversations sur Perso ». Un conseil seulement :
/// rien ne change sans ce clic, et il ne change que le compte des nouvelles conversations (celui d'un lancement) ; une
/// conversation déjà commencée garde le sien.
struct AgentAccountWarning: View {
    @Environment(VigieStore.self) private var store
    let accountID: String?
    /// Propose « Mettre les nouvelles conversations sur… » : seulement quand l'agent part sur le compte des nouvelles
    /// conversations (une conversation continuée garde le sien).
    var offerDefault = true

    var body: some View {
        if let warning = Self.warning(accountID: accountID, accounts: store.accounts, now: store.now) {
            VStack(alignment: .leading, spacing: 6) {
                Label {
                    Text(warning.text)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Theme.warn)
                }
                if !offerDefault {
                    Text("Une conversation commencée garde son compte : pour partir sur un autre, choisis « Nouvelle conversation ».")
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else if let roomiest = warning.roomiest {
                    AsyncButton("Mettre les nouvelles conversations sur \(roomiest.displayName)") {
                        await store.setDefaultAccount(roomiest.id)
                    }
                    .glassButton()
                    .controlSize(.small)
                    .fixedSize()
                    .help("Les prochains lancements et les nouvelles conversations partiront sur \(roomiest.displayName) ; une conversation déjà commencée garde son compte")
                }
            }
        }
    }

    /// Le compte de départ d'un agent : celui des nouvelles conversations, lu dans les comptes de l'app (changé d'ici,
    /// il se voit tout de suite), sinon celui que dit le moteur.
    static func launchAccount(_ store: VigieStore) -> (id: String, name: String)? {
        let known = store.accountsState?.defaultForNew ?? store.accounts.first(where: { $0.isDefault == true })?.id
        if let id = known, let account = store.accounts.first(where: { $0.id == id }) { return (id, account.displayName) }
        guard let account = store.agentsState?.account, let id = account.id else { return nil }
        return (id, account.displayName ?? id)
    }

    /// Seuil d'alerte d'une jauge (session ou semaine).
    nonisolated static let threshold: Double = 90

    /// « Travail 1 est à 100 % de sa session (remise à zéro aujourd'hui à 03:40). Perso a plus de marge. » ; nil si le
    /// compte a de la marge.
    nonisolated static func text(accountID: String?, accounts: [Account], now: Date) -> String? {
        warning(accountID: accountID, accounts: accounts, now: now)?.text
    }

    /// La phrase, et le compte qui a le plus de marge (bien connecté : ni mauvaise adresse, ni doublon ; sous le
    /// seuil), s'il y en a un ; nil si le compte de départ a de la marge.
    nonisolated static func warning(accountID: String?, accounts: [Account], now: Date) -> (text: String, roomiest: Account?)? {
        guard let accountID, let account = accounts.first(where: { $0.id == accountID }),
              let full = fullest(account, now: now) else { return nil }
        let reset = full.window.resetsAt.map { " (remise à zéro \(Fmt.reset($0, now: now)))" } ?? ""
        let head = "\(account.displayName) est à \(Fmt.pct(full.window.pct)) de sa \(full.name)\(reset)."
        let others = accounts.filter {
            $0.id != accountID && !$0.isCodex && !AccountCard.hasProblem($0) && fullest($0, now: now) == nil
        }
        guard let roomiest = others.min(by: { load($0) < load($1) }) else { return (head, nil) }
        return ("\(head) \(roomiest.displayName) a plus de marge.", roomiest)
    }

    /// La jauge pleine (session d'abord, puis semaine) ; nil si les deux sont sous le seuil, ou déjà remises à zéro
    /// (le chiffre d'avant la remise ne compte plus).
    private nonisolated static func fullest(_ account: Account, now: Date) -> (name: String, window: UsageWindow)? {
        func full(_ window: UsageWindow?) -> UsageWindow? {
            guard let window, (window.pct ?? 0) >= threshold, window.resetsAt.map({ $0 > now }) ?? true else { return nil }
            return window
        }
        if let session = full(account.usage?.session) { return ("session", session) }
        if let week = full(account.usage?.week) { return ("semaine", week) }
        return nil
    }

    /// La plus haute des deux jauges (sans chiffre : 0).
    private nonisolated static func load(_ account: Account) -> Double {
        max(account.usage?.session?.pct ?? 0, account.usage?.week?.pct ?? 0)
    }
}

/// Un agent : icône, nom, ce qu'il fait, ses MCP et leur état, « Lancer… ». Son AGENT.md est illisible : la raison
/// (icône rouge), et rien à lancer.
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
                        .textRole(.item)
                    if let description = agent.description, !description.isEmpty {
                        Text(description)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if let problem = agent.problem {
                    Label {
                        Text(problem)
                            .fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(Theme.alert)
                    }
                    .font(.callout)
                }
                if !agent.mcp.isEmpty { AgentMCPStrip(agent: agent) }
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
