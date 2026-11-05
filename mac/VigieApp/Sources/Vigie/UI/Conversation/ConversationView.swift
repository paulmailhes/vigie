import SwiftUI

/// La page d'une conversation, en tuiles : l'État (toujours), l'Échange entre toi et Claude juste dessous avec à côté
/// au plus deux petites tuiles (ce qui cloche, le plan, ce qui est publié), puis ce qui travaille (workflows et agents)
/// et une ligne de détails. Une tuile n'apparaît que si elle a quelque chose à dire ; un clic ouvre le détail à
/// droite, la page restant visible et à jour à côté.
struct ConversationView: View {
    @Environment(VigieStore.self) private var store
    let conversationID: String

    @State private var width: CGFloat = 1000

    /// Sous cette largeur (inspecteur ouvert ou petite fenêtre), tout passe sur une colonne.
    private static let twoColumns: CGFloat = 860

    var body: some View {
        let summary = store.conversation(conversationID)
        let model = store.details[conversationID]
        Group {
            if let summary {
                page(summary, model)
            } else if store.loadedOnce {
                ContentUnavailableView {
                    Label("Conversation introuvable", systemImage: "questionmark.bubble")
                } description: {
                    Text("Elle a sans doute été fermée il y a plus de 48 h.")
                } actions: {
                    Button("Retour à la vue d'ensemble") { store.route = .overview }
                }
            } else {
                LoadingView()
            }
        }
        .navigationTitle(summary?.shortTitle ?? "Conversation")
        .navigationSubtitle(summary?.title ?? "")
        .toolbar {
            if let summary {
                ToolbarItem {
                    if summary.surface == "terminal", let cwd = summary.cwd {
                        // Lancée dans Terminal : l'ouvrir dans VS Code la reprendrait deux fois.
                        Button("Ouvrir le dossier", systemImage: "folder") { SystemActions.openInVSCode(path: cwd) }
                    } else {
                        AsyncButton(summary.openLabel, systemImage: "arrow.up.forward.app") {
                            await store.openConversationInVSCode(summary.id, cwd: summary.cwd)
                        }
                        .help("Ouvrir cette conversation là où elle tourne")
                    }
                }
            }
        }
        .inspector(isPresented: Binding(get: { shownPanel != nil },
                                        set: { if !$0 { store.conversationPanel = nil } })) {
            if let panel = shownPanel, let summary {
                ConversationInspector(panel: panel, summary: summary, model: model)
                    .inspectorColumnWidth(min: 300, ideal: 380, max: 480)
            }
        }
        .onKeyPress(.escape) {
            guard shownPanel != nil else { return .ignored }
            store.conversationPanel = nil
            return .handled
        }
        .task(id: "\(conversationID)|\(store.windowVisible)") {
            await store.follow(conversation: conversationID)
        }
    }

    /// Le détail ouvert, s'il appartient à cette conversation.
    private var shownPanel: ConversationPanel? {
        store.conversationPanelOwner == conversationID ? store.conversationPanel : nil
    }

    private func open(_ panel: ConversationPanel) {
        if shownPanel == panel {
            store.conversationPanel = nil
        } else {
            store.conversationPanel = panel
            store.conversationPanelOwner = conversationID
        }
    }

    @ViewBuilder
    private func page(_ summary: ConversationSummary, _ model: ConversationDetailModel?) -> some View {
        let verdict = ConversationVerdict.make(summary: summary, detail: model?.raw, urgent: store.urgentItems(for: conversationID),
                                               now: store.now) { store.account($0)?.displayName ?? "l'autre compte" }
        Page {
            VStack(alignment: .leading, spacing: 12) {
                StateTile(summary: summary, model: model, verdict: verdict, open: open)
                if let model {
                    let wide = width >= Self.twoColumns
                    let side = SideTiles.kinds(model, now: store.now)
                    if wide && !side.isEmpty {
                        HStack(alignment: .top, spacing: 12) {
                            ExchangeTile(summary: summary, model: model, verdict: verdict, open: open)
                                .frame(maxWidth: .infinity)
                            SideTiles(model: model, open: open)
                                .frame(width: min(320, width * 0.32))
                        }
                    } else {
                        ExchangeTile(summary: summary, model: model, verdict: verdict, open: open)
                        if !side.isEmpty {
                            SideTiles(model: model, open: open)
                        }
                    }
                    work(model)
                    DetailsBar(summary: summary, model: model, open: open)
                        .padding(.top, 2)
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.top, 30)
                }
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        }
    }

    /// Au travail : les workflows (une tuile mère avec ses agents) et les agents seuls. Absent si rien ne tourne.
    @ViewBuilder
    private func work(_ model: ConversationDetailModel) -> some View {
        let now = store.now
        let workflows = model.raw.workflows.filter { Self.visible($0, now: now) }
        let shown = Set(workflows.map { $0.name ?? $0.id })
        // agents seuls, et ceux dont le workflow n'a pas de tuile
        let solo = (model.runningAgents + model.doneAgents.filter { Self.recent($0, now: now) })
            .filter { $0.workflow == nil || !shown.contains($0.workflow ?? "") }
        if !workflows.isEmpty || !solo.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Au travail")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                ForEach(workflows) { workflow in
                    WorkflowTile(workflow: workflow,
                                 agents: model.runningAgents.filter { $0.workflow == (workflow.name ?? workflow.id) },
                                 open: open)
                }
                if !solo.isEmpty {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 260), spacing: 10)], alignment: .leading, spacing: 10) {
                        ForEach(solo.prefix(6)) { agent in
                            AgentTile(agent: agent, open: open)
                        }
                    }
                    if solo.count > 6 {
                        Text("+\(solo.count - 6) agents").font(.callout).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    /// Un workflow : en cours, ou fini depuis moins de 30 min ; en échec ou arrêté, 2 h.
    static func visible(_ workflow: Workflow, now: Date) -> Bool {
        if workflow.status == "running" { return true }
        guard let start = workflow.startedAt else { return false }
        let end = start.addingTimeInterval((workflow.durationMs ?? 0) / 1000)
        let keep: TimeInterval = workflow.status == "failed" || workflow.status == "killed" ? 7200 : 1800
        return now.timeIntervalSince(end) < keep
    }

    /// Un agent seul fini : gardé 10 min (en échec, 2 h).
    static func recent(_ agent: AgentRun, now: Date) -> Bool {
        guard let last = agent.lastAt else { return false }
        return now.timeIntervalSince(last) < (agent.status == "failed" ? 7200 : 600)
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
