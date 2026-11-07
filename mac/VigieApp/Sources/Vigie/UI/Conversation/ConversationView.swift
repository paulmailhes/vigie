import SwiftUI

/// La page d'une conversation, en tuiles : sa barre de réglages, l'État (toujours), juste dessous la ligne Journal ·
/// Fichiers · Tests · MCP (toujours au même endroit, jamais sous le bas de la fenêtre), l'Échange entre toi et Claude
/// avec à côté au plus deux petites tuiles (ce qui cloche, le plan, ce qui est publié), puis ce qui travaille
/// (workflows et agents). Une tuile n'apparaît que si elle a quelque chose à dire ; un clic ouvre le détail à droite,
/// la page restant visible et à jour à côté.
struct ConversationView: View {
    @Environment(VigieStore.self) private var store
    let conversationID: String

    @State private var width: CGFloat = 1000

    /// Sous cette largeur (inspecteur ouvert ou petite fenêtre), tout passe sur une colonne.
    private static let twoColumns: CGFloat = 860
    /// Largeur minimale de la page, détail ouvert, dans la plus petite fenêtre (960 pt).
    private static let pageMinWidth: CGFloat = 340
    /// La colonne de côté (tests, plan, publié).
    private static let sideWidth: CGFloat = 300

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
        .splitColumn(minWidth: Self.pageMinWidth)
        .navigationTitle(summary?.shortTitle ?? "Conversation")
        .navigationSubtitle(subtitle(summary))
        .inspector(isPresented: Binding(get: { shownPanel != nil },
                                        set: { if !$0 { store.conversationPanel = nil } })) {
            if let panel = shownPanel, let summary {
                ConversationInspector(panel: panel, summary: summary, model: model)
                    .splitColumn()
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

    /// Son identité (le titre de VS Code) ; quand plusieurs conversations attendent une décision et qu'elle en est,
    /// sa place devant (« 2e des 3 à décider · … », ⌘J passe à la suivante) : le titre peut être coupé, pas la place.
    private func subtitle(_ summary: ConversationSummary?) -> String {
        let position = store.waitingPosition(of: conversationID).map { "\($0) à décider" }
        return InfoLine.text([position, summary?.title])
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
        let verdict = ConversationVerdict.make(summary: summary, detail: model?.raw, urgent: store.decisionItems(for: conversationID),
                                               now: store.now) { store.account($0)?.displayName ?? "l'autre compte" }
        Page {
            VStack(alignment: .leading, spacing: 12) {
                ConversationBar(summary: summary, contextTokens: model?.raw.contextTokens ?? summary.contextTokens)
                StateTile(summary: summary, model: model, verdict: verdict, open: open)
                if let model {
                    DetailsBar(summary: summary, model: model, open: open)
                    let wide = width >= Self.twoColumns
                    let side = SideTiles.kinds(model, now: store.now)
                    if wide && !side.isEmpty {
                        HStack(alignment: .top, spacing: 12) {
                            ExchangeTile(summary: summary, model: model, verdict: verdict, open: open)
                                .frame(maxWidth: .infinity)
                            SideTiles(model: model, open: open)
                                .frame(width: Self.sideWidth)
                        }
                    } else {
                        ExchangeTile(summary: summary, model: model, verdict: verdict, open: open)
                        if !side.isEmpty {
                            SideTiles(model: model, open: open)
                        }
                    }
                    work(model)
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.top, 30)
                }
            }
        }
        // mesurée sur la page elle-même, pas dans ce qui défile : le contenu ne peut pas changer cette mesure ; les
        // marges de `Page` retirées, la largeur des tuiles s'en déduit sans dépendre de leur contenu
        .onGeometryChange(for: CGFloat.self) { $0.size.width - PageMetrics.margin * 2 } action: { width = $0 }
    }

    /// Au travail : les workflows (une tuile chacun, avec la liste de son avancée) et les agents seuls, sous un titre
    /// de section qui compte les agents en cours. Absent si rien ne tourne.
    @ViewBuilder
    private func work(_ model: ConversationDetailModel) -> some View {
        let now = store.now
        let workflows = model.raw.workflows.filter { Self.visible($0, now: now) }
        let shown = Set(workflows.map { $0.name ?? $0.id })
        // agents seuls, et ceux dont le workflow n'a pas de tuile
        let solo = (model.runningAgents + model.doneAgents.filter { Self.recent($0, now: now) })
            .filter { $0.workflow == nil || !shown.contains($0.workflow ?? "") }
        let run = model.raw.agentRun?.report != nil ? model.raw.agentRun : nil
        let steps = model.raw.now?.plan?.steps ?? []
        if !workflows.isEmpty || !solo.isEmpty || run != nil {
            let running = model.runningAgents.count
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader("Au travail", count: running > 0 ? running : nil, inset: 0)
                if let run, let summary = store.conversation(conversationID) {
                    AgentReportTile(run: run, summary: summary)
                }
                ForEach(workflows) { workflow in
                    // tous ses agents, finis compris : sa tuile en fait la liste d'avancée
                    WorkflowTile(workflow: workflow,
                                 agents: WorkflowProgress.agents(of: workflow, among: model.raw.workflows,
                                                                 in: model.runningAgents + model.doneAgents),
                                 plan: model.raw.now?.plan,
                                 open: open)
                }
                if !solo.isEmpty {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 260), spacing: 12)], alignment: .leading, spacing: 12) {
                        ForEach(solo.prefix(6)) { agent in
                            AgentTile(agent: agent, planSteps: steps, look: .card, open: open)
                        }
                    }
                    if solo.count > 6 {
                        Text("+\(Fmt.count(solo.count - 6, "agent"))").font(.callout).foregroundStyle(.secondary)
                    }
                }
            }
            // 20 pt avant un titre de section (12 d'écart entre tuiles, plus 8)
            .padding(.top, 8)
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

/// La conversation vient d'un lancement d'agent Vigie : son rapport en bref, en tête de « Au travail » ; « Voir le
/// rapport » l'ouvre en entier dans le panneau de droite (`AgentReportPanel`).
struct AgentReportTile: View {
    @Environment(VigieStore.self) private var store
    let run: RecipeRun
    let summary: ConversationSummary

    var body: some View {
        let report = run.report
        VStack(alignment: .leading, spacing: 6) {
            CardTitle("Agent Vigie", trailing: status(report), alert: report?.isBlocked == true)
            VStack(alignment: .leading, spacing: 2) {
                Text(run.displayName)
                    .textRole(.item)
                    .lineLimit(1)
                if let verdict = report?.verdict ?? report?.title {
                    Text(verdict).lineLimit(2)
                }
                if let counts = report?.counts {
                    let parts = [counts.block.flatMap { $0 > 0 ? Fmt.count($0, "bloquant") : nil },
                                 counts.warn.flatMap { $0 > 0 ? "\($0) à corriger" : nil },
                                 counts.ok.flatMap { $0 > 0 ? "\($0) OK" : nil }]
                    if !InfoLine.text(parts).isEmpty {
                        InfoLine(parts: parts)
                    }
                }
            }
            if stale {
                // une phrase : le texte reste lisible en gris, seule l'icône est orange
                Label {
                    Text("Le rapport dit « en cours », mais la conversation ne travaille plus depuis plus de 2 h.")
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Theme.warn)
                }
            }
            // les boutons passent à la ligne quand la page est étroite
            WrapLayout(spacing: 8, lineSpacing: 6) {
                if let step = report?.next.first {
                    AsyncButton(step.label) { await store.sendToRun(run, step) }
                        .glassButton(.primary)
                }
                Button("Voir le rapport") {
                    // le rapport entier s'ouvre à droite, la page reste visible à côté
                    store.showAgentReport(summary.id)
                }
                .glassButton()
            }
        }
        .font(.callout)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quinary, in: .rect(cornerRadius: Theme.corner))
    }

    private func status(_ report: AgentReport?) -> String {
        guard let report else { return "pas encore de rapport" }
        if report.isBlocked { return "arrêté" } // comme le panneau Rapport
        return report.isRunning ? "en cours" : "fini"
    }

    /// Un rapport « en cours » alors que la conversation dort depuis 2 h.
    private var stale: Bool {
        guard run.report?.isRunning == true, summary.state != .working, let last = summary.lastActivity else { return false }
        return store.now.timeIntervalSince(last) > 7200
    }
}
