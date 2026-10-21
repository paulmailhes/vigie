import SwiftUI

/// Le détail d'une conversation : en-tête, « Maintenant » (ta demande, où elle en est, ce qui en est sorti),
/// sa feuille de route (plan, tâches, sinon ses documents de suivi), puis le fil et les onglets de détail.
struct ConversationView: View {
    @Environment(VigieStore.self) private var store
    let conversationID: String

    private static let tabsAnchor = "onglets"

    var body: some View {
        @Bindable var store = store
        let summary = store.conversation(conversationID)
        let model = store.details[conversationID]
        Group {
            if let summary {
                ScrollViewReader { proxy in
                    Page {
                        ConversationHeader(summary: summary, model: model,
                                           contextTokens: model?.raw.contextTokens ?? summary.contextTokens)

                        CardSection {
                            NowSection(summary: summary, model: model)
                        } header: {
                            CardHeader(title: "Maintenant", date: model?.raw.now?.live?.ts ?? model?.raw.now?.ts)
                        }

                        if let plan = model?.raw.now?.plan, !plan.steps.isEmpty {
                            CardSection {
                                PlanView(plan: plan)
                            } header: {
                                CardHeader(title: plan.title ?? "Plan", date: plan.updatedAt)
                            }
                        }

                        if let tasks = model?.raw.now?.tasks, !tasks.isEmpty {
                            CardSection {
                                TaskChecklist(tasks: tasks)
                            } header: {
                                CardHeader(title: "Ses tâches pour ta demande", date: model?.raw.now?.tasksTs)
                            }
                        }

                        if let doc = model?.raw.trackingDoc {
                            CardSection {
                                RoadmapView(doc: doc, cwd: summary.cwd)
                            } header: {
                                CardHeader(title: "Feuille de route · \(doc.title ?? (doc.path as NSString).lastPathComponent)", date: doc.updatedAt)
                            }
                        }

                        CardSection {
                            if let model {
                                ConversationTabContent(tab: store.conversationTab, model: model, cwd: summary.cwd)
                                    .id("\(conversationID)-\(store.conversationTab.rawValue)")
                            } else {
                                HStack {
                                    Spacer()
                                    ProgressView().controlSize(.small)
                                    Spacer()
                                }
                            }
                        } header: {
                            VStack(alignment: .leading, spacing: 8) {
                                Picker("Afficher", selection: $store.conversationTab) {
                                    ForEach(ConversationTab.allCases) { tab in
                                        Text(tab.title).tag(tab)
                                    }
                                }
                                .navigationTabsStyle()
                                .labelsHidden()
                                .font(.body)
                                HStack(spacing: 6) {
                                    Text(store.conversationTab.subtitle)
                                    Spacer(minLength: 8)
                                    if let model {
                                        Text(countText(store.conversationTab, model: model))
                                            .monospacedDigit()
                                    }
                                }
                                .font(.callout)
                                .fontWeight(.regular)
                                .foregroundStyle(.secondary)
                            }
                            .padding(.bottom, 2)
                        }
                        .id(Self.tabsAnchor)
                    }
                    .onChange(of: store.focusTabs && model != nil, initial: true) { _, ready in
                        guard ready else { return }
                        store.focusTabs = false
                        withAnimation(.smooth) { proxy.scrollTo(Self.tabsAnchor, anchor: .top) }
                    }
                }
            } else if store.loadedOnce {
                ContentUnavailableView("Conversation introuvable", systemImage: "questionmark.bubble",
                                       description: Text("Elle a peut-être été fermée il y a plus de 48 h."))
            } else {
                LoadingView()
            }
        }
        .navigationTitle(summary?.shortTitle ?? "Conversation")
        .navigationSubtitle(summary?.title ?? "")
        .toolbar {
            if let cwd = summary?.cwd {
                ToolbarItem {
                    Button("Ouvrir dans VS Code", systemImage: "chevron.left.forwardslash.chevron.right") {
                        SystemActions.openInVSCode(path: cwd)
                    }
                    .help("Ouvrir le dossier du projet dans VS Code")
                }
            }
        }
        .task(id: conversationID) {
            await store.follow(conversation: conversationID)
        }
    }

    private func countText(_ tab: ConversationTab, model: ConversationDetailModel) -> String {
        switch tab {
        case .fil: Fmt.count(model.milestones.count, "jalon")
        case .accepted: Fmt.count(model.accepted.count, "action")
        case .agents: "\(Fmt.int(model.runningAgents.count)) en cours"
        case .files: Fmt.count(model.files.count, "fichier")
        case .tests: Fmt.count(model.tests.count, "vérification")
        case .mcp: Fmt.count(model.raw.mcp.count, "MCP", "MCP")
        }
    }
}

/// Titre d'un bloc avec, à droite, la fraîcheur de l'information.
struct CardHeader: View {
    let title: String
    let date: Date?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title)
            Spacer(minLength: 8)
            if date != nil {
                Label {
                    Freshness(date: date)
                } icon: {
                    Image(systemName: "clock")
                }
                .font(.callout)
                .fontWeight(.regular)
                .foregroundStyle(.secondary)
                .labelStyle(.titleAndIcon)
            }
        }
    }
}

extension View {
    /// Onglets : `.tabs` sur macOS 27 (rendu et lecture VoiceOver d'onglets), segmenté avant.
    @ViewBuilder
    func navigationTabsStyle() -> some View {
        if #available(macOS 27, *) {
            pickerStyle(.tabs)
        } else {
            pickerStyle(.segmented)
        }
    }
}

/// En-tête compact : titre et trois réglages (compte, auto-accept, connecteurs), puis une ligne d'infos.
struct ConversationHeader: View {
    @Environment(VigieStore.self) private var store
    let summary: ConversationSummary
    let model: ConversationDetailModel?
    let contextTokens: Int?

    @State private var pendingAccount: Account?
    @State private var confirmSwitch = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 16) {
                    title
                    Spacer(minLength: 12)
                    controls
                }
                VStack(alignment: .leading, spacing: 10) {
                    title
                    controls
                }
            }
            metaLine
            if let resume = summary.resume {
                HStack(spacing: 10) {
                    Image(systemName: "arrow.clockwise.circle.fill")
                        .foregroundStyle(Theme.alert)
                    Text("Arrêtée pour passer sur \(store.account(resume.to)?.displayName ?? "l'autre compte") : écris-lui un message (« continue ») dans VS Code, elle repart dessus.")
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Button("Ouvrir dans VS Code") {
                        Task { await store.openConversationInVSCode(summary.id, cwd: summary.cwd) }
                    }
                    .glassButton(.primary)
                }
                .padding(10)
                .background(Theme.alert.opacity(0.08), in: .rect(cornerRadius: 10))
            }
        }
        .padding(.horizontal, 6)
        .confirmationDialog(pendingAccount.map { "Passer sur \($0.displayName) ?" } ?? "",
                            isPresented: $confirmSwitch, titleVisibility: .visible, presenting: pendingAccount) { account in
            Button(summary.state == .working ? "À la fin de son travail" : "Passer sur \(account.displayName)") {
                Task { await store.switchAccount(of: summary.id, to: account.id) }
            }
            if summary.state == .working {
                Button("Tout de suite (interrompt)") {
                    Task { await store.switchAccount(of: summary.id, to: account.id, now: true) }
                }
            }
            Button("Annuler", role: .cancel) {}
        } message: { account in
            Text(switchMessage(account))
        }
    }

    private var title: some View {
        Text(summary.title ?? summary.shortTitle)
            .font(.title2.bold())
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
            .help(titleHelp)
    }

    /// Dossier, branche et début : au survol du titre, pas sur la page.
    private var titleHelp: String {
        var parts: [String] = []
        if let cwd = summary.cwd ?? summary.project { parts.append(cwd) }
        if let branch = summary.branch { parts.append("branche \(branch)") }
        if let started = summary.startedAt { parts.append("depuis \(Fmt.when(started, now: store.now))") }
        return parts.joined(separator: " · ")
    }

    private var metaLine: some View {
        HStack(spacing: 14) {
            HStack(spacing: 5) {
                StatusDot(status: summary.state)
                Text(Theme.label(for: summary.state))
                    .foregroundStyle(Theme.needsYou(summary.state) ? AnyShapeStyle(Theme.alert) : AnyShapeStyle(.secondary))
            }
            runningAccountLabel
            if let rate = summary.rate, (rate.tokensPerMin ?? 0) > 0 {
                RateBadge(rate: rate, alert: summary.alert?.isRunaway == true, compact: true, live: summary.state == .working)
            }
            // MCP : seulement s'il y en a à connecter (le détail est sur la page MCP)
            if let count = mcpCount, count > 0, mcpIssues > 0 {
                Button {
                    store.route = .mcp
                } label: {
                    Label("\(Fmt.count(mcpIssues, "MCP", "MCP")) à connecter", systemImage: Icon.mcp)
                        .foregroundStyle(Theme.warn)
                }
                .buttonStyle(.borderless)
                .help("Les MCP de ton Mac et du projet, réglables sur la page MCP")
            }
        }
        .font(.callout)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }

    /// MCP branchés et actifs pour cette conversation (hors connecteurs de compte).
    /// MCP à connecter ou en échec pour le dossier et le compte de la conversation.
    private var mcpIssues: Int {
        model?.raw.mcp.count { $0.mcpStatus == .needsAuth || $0.mcpStatus == .failed } ?? 0
    }


    private var mcpCount: Int? {
        guard let model else { return nil }
        return model.raw.mcp.count { ($0.enabled ?? true) && $0.mcpScope != .connector }
    }

    private var controls: some View {
        GlassEffectContainer(spacing: 8) {
            HStack(spacing: 8) {
                if summary.isCodex {
                    Label("Codex", systemImage: "chevron.left.forwardslash.chevron.right")
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(.quinary, in: .capsule)
                        .help("Conversation Codex (OpenAI), sur ton compte ChatGPT")
                    autoAcceptMenu
                } else {
                    accountMenu
                    autoAcceptMenu
                    connectorsMenu
                }
            }
        }
        .tint(.primary) // réglages : neutres, le bleu reste aux actions
        .fixedSize()
    }

    // MARK: Compte

    private var currentAccount: Account? { store.account(summary.accountId) }

    private var accountMenu: some View {
        Menu {
            ForEach(store.accounts) { account in
                Button {
                    guard account.id != currentAccount?.id else { return }
                    pendingAccount = account
                    confirmSwitch = true
                } label: {
                    if account.id == currentAccount?.id {
                        Label(account.displayName, systemImage: "checkmark")
                    } else {
                        Text(account.isConnected ? account.displayName : "\(account.displayName) (pas connecté)")
                    }
                }
                .disabled(!account.isConnected && account.id != currentAccount?.id)
            }
        } label: {
            Label(currentAccount?.displayName ?? "Compte", systemImage: "person.crop.circle")
        }
        .menuStyle(.button)
        .glassButton()
        .help("Compte de cette conversation")
    }

    private func switchMessage(_ account: Account) -> String {
        var text = summary.state == .working
            ? "Elle travaille : elle change de compte à la fin de son tour, ou tout de suite en l'interrompant (tu écris « continue » pour la reprendre)."
            : "Elle reprend sur \(account.displayName) avec tout son historique."
        if let contextTokens, contextTokens > 0 {
            text += " ≈ \(Fmt.tokens(contextTokens)) tokens relus."
        }
        return text
    }

    private func accountName(_ id: String?) -> String {
        guard let id else { return "?" }
        return store.account(id)?.displayName ?? id
    }

    /// Le compte du processus qui tourne vraiment, la bascule en attente, et l'historique en infobulle.
    @ViewBuilder
    private var runningAccountLabel: some View {
        if let info = summary.account, let running = info.running {
            let pendingTo = info.pending?.to ?? summary.pendingAccountId.flatMap { $0 != running ? $0 : nil }
            HStack(spacing: 6) {
                Label("Tourne sur \(accountName(running))", systemImage: "person.crop.circle")
                    .foregroundStyle(pendingTo == nil ? AnyShapeStyle(.primary) : AnyShapeStyle(Theme.warn))
                if let pendingTo {
                    Text("→ \(accountName(pendingTo)) à la fin du tour")
                    Button("Tout de suite") {
                        Task { await store.switchAccount(of: summary.id, to: pendingTo, now: true) }
                    }
                    .buttonStyle(.borderless)
                    .help("Interrompt son travail et relance la conversation sur \(accountName(pendingTo)). Tu écris « continue » pour la reprendre.")
                }
            }
            .help(launchHistoryText(info))
        }
    }

    private func launchHistoryText(_ info: ConversationAccount) -> String {
        let lines = (info.history ?? []).reversed().prefix(6).map { launch in
            let when = launch.ts.map { Fmt.when($0, now: store.now) } ?? "?"
            return "\(when) : lancée sur \(accountName(launch.accountId))"
        }
        return lines.isEmpty ? "Compte du processus en cours" : "Lancements :\n" + lines.joined(separator: "\n")
    }

    // MARK: Auto-accept

    private var autoAcceptMenu: some View {
        Menu {
            Button {
                Task { await store.setAutoAccept(nil, for: summary.id) }
            } label: {
                choiceLabel("Comme le réglage général (\(store.autoAccept ? "oui" : "non"))", selected: summary.autoAcceptOverride == nil)
            }
            Button {
                Task { await store.setAutoAccept(true, for: summary.id) }
            } label: {
                choiceLabel("Toujours", selected: summary.autoAcceptOverride == true)
            }
            Button {
                Task { await store.setAutoAccept(false, for: summary.id) }
            } label: {
                choiceLabel("Jamais", selected: summary.autoAcceptOverride == false)
            }
        } label: {
            Label(autoAcceptText, systemImage: (summary.autoAccept ?? false) ? "checkmark.shield" : "shield.slash")
        }
        .menuStyle(.button)
        .glassButton()
        .help("Auto-accept pour cette conversation")
    }

    private var autoAcceptText: String {
        switch summary.autoAcceptOverride {
        case true?: "Auto-accept : toujours"
        case false?: "Auto-accept : jamais"
        case nil: "Auto-accept : \((summary.autoAccept ?? store.autoAccept) ? "oui" : "non")"
        }
    }

    // MARK: Connecteurs

    private var connectorsMenu: some View {
        let on = summary.connectors == "on"
        return Menu {
            Button {
                Task { await store.setConnectors(false, for: summary.id) }
            } label: {
                choiceLabel("Coupés", selected: !on)
            }
            Button {
                Task { await store.setConnectors(true, for: summary.id) }
            } label: {
                choiceLabel("Activés", selected: on)
            }
        } label: {
            Label(on ? "Connecteurs : activés" : "Connecteurs : coupés", systemImage: on ? "link" : "link.badge.plus")
        }
        .menuStyle(.button)
        .glassButton()
        .help("Connecteurs de compte (claude.ai) pour cette conversation")
    }

    @ViewBuilder
    private func choiceLabel(_ text: String, selected: Bool) -> some View {
        if selected {
            Label(text, systemImage: "checkmark")
        } else {
            Text(text)
        }
    }
}
