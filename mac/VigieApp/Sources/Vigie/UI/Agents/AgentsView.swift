import SwiftUI

/// Agents : tes lancements (le rapport de chaque agent) dès qu'il y en a, puis les recettes prêtes à lancer, livrées
/// avec Vigie (agents/<id>/AGENT.md, remplacés à chaque mise à jour). L'ordre des sections ne change jamais selon
/// l'état d'un lancement. Une rangée par agent : ce qu'il fait, les MCP dont il a besoin et leur état, et « Lancer… »
/// qui ouvre son formulaire.
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

    /// « 2 agents · 1 lancement en cours · 3 à faire » : un état chiffré, 3 infos au plus.
    private var subtitle: String {
        guard let state = store.agentsState else { return "" }
        let runs = store.agentRuns?.runs ?? []
        let running = runs.count { RecipeRunState($0.report) == .running }
        let todo = runs.reduce(0) { $0 + ($1.report?.isRunning == false ? ($1.report?.openTodo.count ?? 0) : 0) }
        return InfoLine.text([Fmt.count(state.agents.count, "agent"),
                              running > 0 ? Fmt.count(running, "lancement en cours", "lancements en cours") : nil,
                              todo > 0 ? "\(todo) à faire" : nil])
    }

    private func content(_ state: AgentLibrary) -> some View {
        Form {
            // Tes lancements d'abord, dès qu'il y en a un : leurs rapports t'attendent, les recettes se lancent
            // rarement. Ordre fixe : la page ne saute pas quand un lancement finit.
            if let runs = store.agentRuns?.runs, !runs.isEmpty {
                RecipeRunsSection(runs: runs)
            }
            Section {
                ForEach(state.agents) { agent in
                    AgentRecipeRow(agent: agent) { launching = agent }
                }
            } header: {
                SectionHeader("Prêts à lancer", count: state.agents.count,
                              note: "Chacun prépare le dossier du projet, puis ouvre une conversation Claude Code qui suit sa consigne, dans VS Code ou dans l'app Claude.",
                              inset: 0)
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
/// avec le compte qui a le plus de marge. Un conseil seulement : rien ne change sans clic (et un lancement part
/// toujours sur le compte des nouvelles conversations).
struct AgentAccountWarning: View {
    @Environment(VigieStore.self) private var store
    let accountID: String?

    var body: some View {
        if let text = Self.text(accountID: accountID, accounts: store.accounts, now: store.now) {
            Label {
                Text(text)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Theme.warn)
            }
        }
    }

    /// Seuil d'alerte d'une jauge (session ou semaine).
    nonisolated static let threshold: Double = 90

    /// « Travail 1 est à 100 % de sa session (remise à zéro aujourd'hui à 03:40). Perso a plus de marge : pour lancer
    /// dessus, change le compte des nouvelles conversations dans Comptes. » ; nil si le compte a de la marge.
    nonisolated static func text(accountID: String?, accounts: [Account], now: Date) -> String? {
        guard let accountID, let account = accounts.first(where: { $0.id == accountID }),
              let full = fullest(account, now: now) else { return nil }
        let reset = full.window.resetsAt.map { " (remise à zéro \(Fmt.reset($0, now: now)))" } ?? ""
        let head = "\(account.displayName) est à \(Fmt.pct(full.window.pct)) de sa \(full.name)\(reset)."
        // un autre compte bien connecté (ni mauvaise adresse, ni doublon) et sous le seuil
        let others = accounts.filter {
            $0.id != accountID && !$0.isCodex && !AccountCard.hasProblem($0) && fullest($0, now: now) == nil
        }
        guard let roomiest = others.min(by: { load($0) < load($1) }) else { return head }
        return "\(head) \(roomiest.displayName) a plus de marge : pour lancer dessus, change le compte des nouvelles conversations dans Comptes."
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
