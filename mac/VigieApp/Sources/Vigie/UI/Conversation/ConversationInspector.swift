import SwiftUI

/// Le détail ouvert à droite de la page d'une conversation : la page reste visible et à jour à côté ; Échap le ferme,
/// un autre clic en remplace le contenu. Un seul titre, dans la barre fixe du haut (il reste visible quand on fait
/// défiler, à côté du bouton Fermer) ; les blocs du contenu se titrent en surtitres (`CardTitle`).
struct ConversationInspector: View {
    @Environment(VigieStore.self) private var store
    let panel: ConversationPanel
    let summary: ConversationSummary
    let model: ConversationDetailModel?

    var body: some View {
        VStack(spacing: 0) {
            bar(heading(model))
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if case .answers = panel {
                        answers
                    } else if let model {
                        content(model)
                    } else {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    // MARK: Barre du haut

    /// Le seul titre du panneau (`.title3.bold()`, comme `ObjectHeader`), son sous-titre dessous (deux lignes au plus,
    /// texte entier au survol) et le bouton Fermer à droite.
    private func bar(_ heading: PanelHeading) -> some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(heading.title)
                    .font(.title3.bold())
                    .lineLimit(heading.titleLines)
                    .help(heading.help ?? heading.title)
                    .accessibilityAddTraits(.isHeader)
                if let subtitle = heading.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .lineLimit(2)
                        .help(subtitle)
                }
            }
            Spacer(minLength: 8)
            IconButton("Fermer", systemImage: "xmark", help: "Fermer (Échap)") { store.conversationPanel = nil }
                .padding(.top, -4)
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 10)
    }

    /// Le titre du panneau d'après ce qu'il montre : le nom précis de l'objet (un agent, un workflow, un plan, le
    /// résumé de ta demande), sinon le nom de la liste avec ce qu'elle contient.
    private func heading(_ model: ConversationDetailModel?) -> PanelHeading {
        if case .answers = panel { return answersHeading }
        guard let model else { return PanelHeading(title: fallbackTitle) }
        let detail = model.raw
        switch panel {
        case .request:
            let when = detail.current?.start.map { Fmt.when($0, now: store.now) }
            if let brief = detail.current?.brief?.trimmingCharacters(in: .whitespacesAndNewlines), !brief.isEmpty {
                return PanelHeading(title: brief, subtitle: InfoLine.text(["Ta demande", when]), titleLines: 2)
            }
            return PanelHeading(title: "Ta demande", subtitle: when)
        case .message(let index):
            guard detail.messages.indices.contains(index) else { return PanelHeading(title: fallbackTitle) }
            let message = detail.messages[index]
            return PanelHeading(title: message.isReport ? "Compte rendu de Claude" : "Message de Claude",
                                subtitle: InfoLine.text([message.kind == "live" ? "en direct" : nil,
                                                         ConversationVerdict.recent(message.ts, now: store.now)]))
        case .thread:
            return PanelHeading(title: "Tous les échanges", subtitle: Fmt.count(detail.chapters.count, "demande"))
        case .agent(let id):
            guard let agent = agent(id, in: model) else { return PanelHeading(title: fallbackTitle) }
            let raw = InfoLine.text([agent.title, agent.workflow])
            return PanelHeading(title: Fmt.agentTitle(name: agent.name, title: agent.title, id: agent.id,
                                                      planSteps: detail.now?.plan?.steps ?? []),
                                subtitle: InfoLine.text(["Agent", nonEmpty(agent.phase).map { "phase \($0)" },
                                                         nonEmpty(agent.workflow).map { "workflow \(Fmt.workflowTitle($0))" }]),
                                help: raw.isEmpty ? nil : raw)
        case .workflow(let id):
            guard let workflow = detail.workflows.first(where: { $0.id == id }) else { return PanelHeading(title: fallbackTitle) }
            let raw = workflow.name ?? workflow.id
            return PanelHeading(title: Fmt.workflowTitle(raw),
                                subtitle: InfoLine.text(["Workflow \(WorkflowDetail.status(workflow))",
                                                         workflow.startedAt.map { "lancé \(Fmt.when($0, now: store.now))" },
                                                         Fmt.duration(ms: workflow.durationMs)]),
                                help: raw)
        case .plan:
            return planHeading(detail)
        case .tests:
            let count = Fmt.count(model.tests.count, "vérification")
            return PanelHeading(title: "Tests",
                                subtitle: model.testsFailedCount > 0 ? "\(count), dont \(Fmt.int(model.testsFailedCount)) en échec" : count)
        case .files:
            let published = model.artifacts.count
            return PanelHeading(title: "Fichiers",
                                subtitle: InfoLine.text([Fmt.count(model.files.count, "fichier"),
                                                         published > 0 ? "\(Fmt.count(published, "publié")) sur claude.ai" : nil]))
        case .journal:
            return PanelHeading(title: "Journal", subtitle: journalSubtitle(model.feed.count))
        case .mcp:
            let count = detail.mcp.count
            return PanelHeading(title: "MCP",
                                subtitle: count == 0 ? nil
                                    : "\(Fmt.count(count, "MCP", "MCP")), et leur état pour le dossier et le compte de cette conversation.")
        case .background:
            return PanelHeading(title: "En fond", subtitle: "Ce que cette conversation a laissé tourner.")
        case .answers:
            return answersHeading
        case .report:
            guard let run = detail.agentRun else { return PanelHeading(title: fallbackTitle) }
            return AgentReportPanel.heading(run, now: store.now)
        }
    }

    /// Le titre tant que le détail n'est pas lu, ou quand l'objet n'y est plus.
    private var fallbackTitle: String {
        switch panel {
        case .request: "Ta demande"
        case .message: "Message de Claude"
        case .thread: "Tous les échanges"
        case .agent: "Agent"
        case .workflow: "Workflow"
        case .plan: "Plan"
        case .tests: "Tests"
        case .files: "Fichiers"
        case .journal: "Journal"
        case .mcp: "MCP"
        case .background: "En fond"
        case .answers: "À relire"
        case .report: "Rapport de l'agent"
        }
    }

    /// Plan : son nom seul (le chemin du fichier est dans l'aide de « Ouvrir le plan ») ; sans plan, le premier bloc
    /// qui reste (ses tâches, ou la feuille de route) devient le titre.
    private func planHeading(_ detail: ConversationDetail) -> PanelHeading {
        if let plan = detail.now?.plan, !plan.steps.isEmpty {
            return PanelHeading(title: Self.planName(plan))
        }
        if let tasks = detail.now?.tasks, !tasks.isEmpty {
            return PanelHeading(title: "Ses tâches pour ta demande",
                                subtitle: InfoLine.text([Self.tasksLine(tasks),
                                                         detail.now?.tasksTs.map { Freshness.text(date: $0, now: store.now) }]))
        }
        if let doc = detail.trackingDoc {
            return PanelHeading(title: "Feuille de route", subtitle: doc.updatedAt.map { Freshness.text(date: $0, now: store.now) })
        }
        return PanelHeading(title: "Plan")
    }

    /// « Plan d'exécution 1.4 » (sans le « # » d'un titre Markdown), sinon le nom du fichier.
    static func planName(_ plan: WorkPlan) -> String {
        if let title = plan.title?.replacing(/^#+\s*/, with: "").trimmingCharacters(in: .whitespaces), !title.isEmpty {
            return title
        }
        if let file = plan.file, !file.isEmpty { return (file as NSString).lastPathComponent }
        return "Plan"
    }

    /// « 3/5 tâches ».
    static func tasksLine(_ tasks: [TaskItem]) -> String {
        "\(Fmt.int(tasks.count { $0.state == .done }))/\(Fmt.int(tasks.count)) \(tasks.count > 1 ? "tâches" : "tâche")"
    }

    /// « 20 actions de Claude, et qui les a décidées. » : le Journal en montre 150 au plus.
    private func journalSubtitle(_ total: Int) -> String? {
        switch total {
        case 0: nil
        case 1: "1 action de Claude, et qui l'a décidée."
        case 151...: "Les 150 dernières actions de Claude, et qui les a décidées."
        default: "\(Fmt.count(total, "action")) de Claude, et qui les a décidées."
        }
    }

    /// Ce qui reste pour toi dans cette conversation : « À regarder » (ce qui a mal tourné, ce que tu dois faire
    /// toi-même) et « À relire » (ce que Vigie a choisi pour toi). Le titre dit ce que le panneau contient.
    private var answersHeading: PanelHeading {
        let look = store.lookItems(for: summary.id)
        let reread = store.rereadItems(for: summary.id)
        switch (look.isEmpty, reread.isEmpty) {
        case (false, true): return PanelHeading(title: "À regarder", subtitle: "Ce qui a mal tourné, ou ce que tu dois faire toi-même.")
        case (false, false): return PanelHeading(title: "À regarder et à relire", subtitle: "Ce qui a mal tourné, et ce que Vigie a choisi pour toi.")
        default: return PanelHeading(title: "À relire", subtitle: reread.isEmpty ? nil : "Ce que Vigie a choisi pour toi.")
        }
    }

    private func agent(_ id: String, in model: ConversationDetailModel) -> AgentRun? {
        (model.runningAgents + model.doneAgents).first { $0.id == id }
    }

    private func nonEmpty(_ value: String?) -> String? {
        value?.isEmpty == false ? value : nil
    }

    // MARK: Contenu

    @ViewBuilder
    private func content(_ model: ConversationDetailModel) -> some View {
        let detail = model.raw
        switch panel {
        case .request:
            if let current = detail.current {
                MarkdownBlocks(text: current.text ?? current.prompt ?? "")
                if let relaunch = current.relaunch, let ts = relaunch.ts {
                    note("Relancée par « \(relaunch.prompt ?? "") » \(Fmt.when(ts, now: store.now)).")
                }
            }
        case .message(let index):
            if detail.messages.indices.contains(index) {
                let message = detail.messages[index]
                MarkdownBlocks(text: message.text ?? "")
                if (message.text ?? "").hasSuffix("…") {
                    note("La suite est dans la conversation.")
                    AsyncButton(summary.openLabel) { await store.openConversationInVSCode(summary.id, cwd: summary.cwd) }
                        .glassButton()
                }
            } else {
                note("Ce message n'est plus parmi les derniers.")
            }
        case .thread:
            ForEach(detail.chapters) { chapter in
                ThreadPair(chapter: chapter)
                Divider()
            }
        case .agent(let id):
            if let agent = agent(id, in: model) {
                AgentDetail(agent: agent, model: model)
            } else {
                note("Cet agent n'est plus dans la conversation.")
            }
        case .workflow(let id):
            if let workflow = detail.workflows.first(where: { $0.id == id }) {
                WorkflowDetail(workflow: workflow, model: model)
            } else {
                note("Ce workflow n'est plus dans la conversation.")
            }
        case .plan:
            plan(detail)
        case .tests:
            rows(model.tests.sorted { ($0.value.outcome == .failed ? 0 : 1) < ($1.value.outcome == .failed ? 0 : 1) }.prefix(80).map { $0 }) { row in
                TestRow(test: row.value)
            }
        case .files:
            if !model.artifacts.isEmpty {
                PanelBlock("Publié sur claude.ai", trailing: Fmt.int(model.artifacts.count), compact: true) {
                    rows(Array(model.artifacts.prefix(10))) { ArtifactRow(artifact: $0.value) }
                }
            }
            ForEach(model.filesByLocation, id: \.0) { location, items in
                PanelBlock(Theme.title(for: location), trailing: Fmt.int(items.count), compact: true) {
                    rows(Array(items.prefix(60))) { FileRow(file: $0.value, cwd: summary.cwd) }
                }
            }
        case .journal:
            if model.feed.isEmpty {
                EmptyRow(text: "Aucune action pour l'instant")
            } else {
                rows(Array(model.feed.prefix(150))) { AcceptedRow(item: $0.value) }
            }
        case .mcp:
            VStack(alignment: .leading, spacing: 8) {
                ConversationMCPList(model: model, cwd: summary.cwd)
            }
        case .background:
            if detail.processes.isEmpty && detail.background.isEmpty {
                note("Rien ne tourne en fond pour cette conversation.")
            }
            ForEach(detail.processes) { group in
                ProcessLine(group: group)
            }
            if !detail.background.isEmpty {
                PanelBlock("Commandes lancées en fond") {
                    ForEach(detail.background) { command in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(command.description ?? "Commande")
                            if let text = command.command {
                                CodeLine(text).textSelection(.enabled)
                            }
                            if let start = command.startedAt {
                                InfoLine("depuis \(Fmt.age(since: start, now: store.now))")
                            }
                        }
                    }
                }
            }
            Button("Voir En fond", systemImage: "memorychip") { store.route = .background }
                .buttonStyle(.link)
        case .answers:
            answers
        case .report:
            if let run = detail.agentRun {
                AgentReportPanel(run: run, conversationID: summary.id)
            } else {
                note("Ce rapport n'est plus dans la conversation.")
            }
        }
    }

    /// Le plan, puis ses tâches pour ta demande ; sans plan, la feuille de route. Le premier bloc est le titre du
    /// panneau, les suivants ont leur surtitre.
    @ViewBuilder
    private func plan(_ detail: ConversationDetail) -> some View {
        let plan = detail.now?.plan.flatMap { $0.steps.isEmpty ? nil : $0 }
        let tasks = detail.now?.tasks ?? []
        if plan == nil && tasks.isEmpty && detail.trackingDoc == nil {
            note("Pas de plan ni de tâches pour l'instant.")
        }
        if let plan {
            PlanView(plan: plan)
        }
        if !tasks.isEmpty {
            if plan != nil {
                PanelBlock("Ses tâches pour ta demande", trailing: Self.tasksLine(tasks),
                           help: detail.now?.tasksTs.map { Freshness.text(date: $0, now: store.now) }) {
                    TaskChecklist(tasks: tasks)
                }
            } else {
                TaskChecklist(tasks: tasks)
            }
        }
        if plan == nil, let doc = detail.trackingDoc {
            if tasks.isEmpty {
                RoadmapView(doc: doc, cwd: summary.cwd, collapsed: true)
            } else {
                PanelBlock("Feuille de route", help: doc.updatedAt.map { Freshness.text(date: $0, now: store.now) }) {
                    RoadmapView(doc: doc, cwd: summary.cwd, collapsed: true)
                }
            }
        }
    }

    /// « À regarder » puis « À relire », chacun sous son surtitre quand les deux sont là.
    @ViewBuilder
    private var answers: some View {
        let look = store.lookItems(for: summary.id)
        let reread = store.rereadItems(for: summary.id)
        if look.isEmpty && reread.isEmpty {
            note("Plus rien à regarder ni à relire pour cette conversation.")
        } else if !look.isEmpty && !reread.isEmpty {
            PanelBlock("À regarder", trailing: Fmt.int(look.count)) { reviewRows(look) }
            PanelBlock("À relire", trailing: Fmt.int(reread.count)) { reviewRows(reread) }
        } else {
            reviewRows(look + reread)
        }
    }

    private func reviewRows(_ items: [ReviewItem]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(items) { item in
                ReviewRow(item: item, inConversation: true)
                Divider()
            }
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }

    private func rows<Item: Identifiable, Row: View>(_ items: [Item], @ViewBuilder row: @escaping (Item) -> Row) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(items) { item in
                row(item).padding(.vertical, 6)
                Divider()
            }
        }
    }
}

/// Le titre de la barre du panneau, son sous-titre, et le nom brut au survol du titre.
struct PanelHeading: Equatable {
    var title: String
    var subtitle: String? = nil
    /// Au survol du titre : le nom brut (identifiant d'un agent, nom d'un workflow en tirets).
    var help: String? = nil
    var titleLines = 3
}

/// Un bloc du panneau de droite : son surtitre (`CardTitle`, chiffre à droite), le contenu dessous. 4 pt de plus
/// au-dessus du surtitre que l'écart entre blocs ; `compact` pour un groupe dans une liste (groupes de fichiers).
struct PanelBlock<Content: View>: View {
    let title: String
    var trailing: String? = nil
    var alert = false
    var compact = false
    /// Au survol du surtitre (date de mise à jour…).
    var help: String? = nil
    let content: Content

    init(_ title: String, trailing: String? = nil, alert: Bool = false, compact: Bool = false, help: String? = nil,
         @ViewBuilder content: () -> Content) {
        self.title = title
        self.trailing = trailing
        self.alert = alert
        self.compact = compact
        self.help = help
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let help {
                CardTitle(title, trailing: trailing, alert: alert, compact: compact).help(help)
            } else {
                CardTitle(title, trailing: trailing, alert: alert, compact: compact)
            }
            content
        }
        .padding(.top, 4)
    }
}

/// Une demande et ce qu'elle a donné, dans « Tous les échanges ».
struct ThreadPair: View {
    @Environment(VigieStore.self) private var store
    let chapter: Chapter

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                CardTitle(InfoLine.text(["Toi", chapter.start.map { Fmt.when($0, now: store.now) }]), compact: true, color: Theme.youText)
                if let duration = chapter.durationMs, duration > 60_000 {
                    // une durée finie se dit avec son verbe : « a pris 42 min »
                    Text("a pris \(Fmt.duration(ms: duration))").font(.caption).foregroundStyle(.secondary).monospacedDigit()
                }
            }
            Text(chapter.prompt ?? "").lineLimit(3).textSelection(.enabled)
            if let outcome = chapter.outcome, !outcome.isEmpty {
                CardTitle("Claude", compact: true)
                Text(outcome).lineLimit(4).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if let stats = chapter.stats {
                // trois faits au plus : les commits et les fichiers d'abord, puis ce qui a travaillé
                let facts = [stats.commits.flatMap { $0 > 0 ? Fmt.count($0, "commit") : nil },
                             stats.files.flatMap { $0 > 0 ? Fmt.count($0, "fichier") : nil },
                             stats.workflows.flatMap { $0 > 0 ? Fmt.count($0, "workflow") : nil },
                             stats.agents.flatMap { $0 > 0 ? Fmt.count($0, "agent") : nil }].compactMap { $0 }
                if !facts.isEmpty {
                    InfoLine(parts: Array(facts.prefix(3)))
                }
            }
        }
        .font(.callout)
    }
}

/// La petite page d'un agent : ce qu'on lui a demandé, ce qu'il fait, son résultat, le temps et sa base, ses actions.
/// Son nom est le titre du panneau.
struct AgentDetail: View {
    @Environment(VigieStore.self) private var store
    let agent: AgentRun
    let model: ConversationDetailModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let prompt = agent.prompt, !prompt.isEmpty {
                PanelBlock("Ce qu'on lui a demandé") { Text(prompt).textSelection(.enabled) }
            }
            if agent.status == "running" {
                PanelBlock("En ce moment") {
                    Text("▸ \(agent.lastAction ?? "démarre")\(agent.lastAt.map { " · \(Fmt.ago($0, now: store.now))" } ?? "")")
                }
            } else {
                let failed = agent.status == "failed"
                PanelBlock(failed ? "En échec" : "Résultat", alert: failed) {
                    Text(agent.result ?? (failed ? "Il s'est arrêté sans résultat." : "Pas de résultat lu."))
                        .textSelection(.enabled)
                }
            }
            PanelBlock("Temps") {
                VStack(alignment: .leading, spacing: 2) {
                    Text(timeLine)
                    if let basis = estimateBasis {
                        Text(basis)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            let actions = model.raw.activity.filter { $0.agent == agent.title }.prefix(10)
            if !actions.isEmpty {
                PanelBlock("Ses dernières actions") {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(actions.enumerated()), id: \.offset) { _, action in
                            HStack(alignment: .firstTextBaseline) {
                                Text(action.title ?? "Action").lineLimit(1).help(action.title ?? "")
                                if let ok = action.ok {
                                    // la couleur ne signale que ce qui a mal tourné
                                    Text(ok ? "réussie" : "en échec")
                                        .font(.caption)
                                        .foregroundStyle(ok ? AnyShapeStyle(.secondary) : AnyShapeStyle(Theme.alertText))
                                }
                                Spacer(minLength: 6)
                                Text(Fmt.when(action.ts, now: store.now)).font(.caption).foregroundStyle(.secondary).monospacedDigit()
                            }
                        }
                    }
                }
            }
            let counts = [agent.actions.flatMap { $0 > 0 ? Fmt.count($0, "action") : nil },
                          agent.files.flatMap { $0 > 0 ? Fmt.count($0, "fichier") : nil },
                          agent.tests.flatMap { $0 > 0 ? Fmt.count($0, "test") : nil }]
            if !InfoLine.text(counts).isEmpty {
                InfoLine(parts: counts)
            }
        }
        .font(.callout)
    }

    /// D'où vient l'estimation, en mots simples : « Estimé d'après les 4 agents « Faire » déjà finis, qui ont pris
    /// environ 12 min. » (la médiane de leur durée).
    private var estimateBasis: String? {
        guard let estimate = agent.estimate, let median = estimate.medianMs, let basis = estimate.basis, basis > 0 else { return nil }
        let duration = Fmt.duration(ms: median)
        guard !duration.isEmpty else { return nil }
        let phase = agent.phase.flatMap { $0.isEmpty ? nil : " « \($0) »" } ?? ""
        if basis == 1 { return "Estimé d'après l'agent\(phase) déjà fini, qui a pris environ \(duration)." }
        return "Estimé d'après les \(Fmt.int(basis)) agents\(phase) déjà finis, qui ont pris environ \(duration)."
    }

    /// Une ligne seule : elle commence par une majuscule (« Depuis 18 min · reste ≈ 35 min », « A pris 12 min · fini
    /// 01:17 »).
    private var timeLine: String {
        guard let start = agent.startedAt else { return Fmt.duration(ms: agent.durationMs) }
        if agent.status == "running" {
            var text = "depuis \(Fmt.age(since: start, now: store.now))"
            if let ends = agent.estimate?.endsAt, ends > store.now, agent.estimate?.longer != true {
                text += " · reste ≈ \(Fmt.duration(ms: max(5, (ends.timeIntervalSince(store.now) / 60 / 5).rounded() * 5) * 60_000))"
            } else if agent.estimate != nil {
                text += " · plus long que les autres"
            }
            return ConversationVerdict.sentence(text)
        }
        let end = agent.lastAt.map { " · fini \(Fmt.when($0, now: store.now))" } ?? ""
        return ConversationVerdict.sentence("a pris \(Fmt.duration(ms: agent.durationMs))\(end)")
    }
}

/// La page d'un workflow : son résultat, sa dernière ligne de journal, ses phases et leurs compteurs, ses agents par
/// phase. Son nom est le titre du panneau.
struct WorkflowDetail: View {
    @Environment(VigieStore.self) private var store
    let workflow: Workflow
    let model: ConversationDetailModel

    var body: some View {
        let mine = (model.runningAgents + model.doneAgents).filter { $0.workflow == (workflow.name ?? workflow.id) }
        // un agent sans nom (« faire:C7 ») prend le libellé de l'étape du plan qu'il fait
        let steps = model.raw.now?.plan?.steps ?? []
        VStack(alignment: .leading, spacing: 14) {
            if let result = workflow.result ?? workflow.summary {
                Text(result).textSelection(.enabled)
            }
            if let log = workflow.lastLog {
                Text("Journal : \(log)").foregroundStyle(.secondary)
            }
            ForEach(phases(mine), id: \.title) { phase in
                PanelBlock(phase.title, trailing: phase.line) {
                    ForEach(phase.agents) { agent in
                        AgentTile(agent: agent, planSteps: steps) { panel in
                            store.conversationPanel = panel
                        }
                    }
                }
            }
        }
        .font(.callout)
    }

    /// « en cours », « en échec », « arrêté », « fini ».
    static func status(_ workflow: Workflow) -> String {
        switch workflow.status {
        case "running": "en cours"
        case "failed": "en échec"
        case "killed": "arrêté"
        default: "fini"
        }
    }

    private struct Phase { var title: String; var line: String; var agents: [AgentRun] }

    private func phases(_ agents: [AgentRun]) -> [Phase] {
        let titles = workflow.phaseProgress.map(\.title)
        let known = titles.isEmpty ? Array(Set(agents.compactMap(\.phase))).sorted() : titles
        var list = known.map { title -> Phase in
            let progress = workflow.phaseProgress.first { $0.title == title }
            var parts: [String] = []
            if let done = progress?.done, done > 0 { parts.append(Fmt.count(done, "fini", "finis")) }
            if let failed = progress?.failed, failed > 0 { parts.append("\(failed) en échec") }
            if let running = progress?.running, running > 0 { parts.append("\(running) en cours") }
            return Phase(title: title, line: parts.joined(separator: " · "), agents: agents.filter { $0.phase == title })
        }
        let loose = agents.filter { $0.phase == nil || !known.contains($0.phase ?? "") }
        if !loose.isEmpty { list.append(Phase(title: "Autres", line: "", agents: loose)) }
        return list
    }
}

/// Un groupe de processus laissé en fond, dans le détail d'une conversation : son nom, ce qu'il prend et depuis
/// quand ; « Ouvrir localhost:5173 » pour un serveur, « Arrêter ». Les boutons passent sous le texte quand la place
/// manque.
struct ProcessLine: View {
    @Environment(VigieStore.self) private var store
    let group: BackgroundGroup

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                label
                Spacer(minLength: 6)
                buttons
            }
            VStack(alignment: .leading, spacing: 6) {
                label
                buttons
            }
        }
        .font(.callout)
    }

    private var label: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(group.label ?? "Commande").textRole(.item).lineLimit(1).help(group.label ?? "")
            let facts = [group.detail, group.memoryMb.map { Fmt.memory(mb: $0) },
                         group.startedAt.map { "depuis \(Fmt.age(since: $0, now: store.now))" }]
            if !InfoLine.text(facts).isEmpty {
                InfoLine(parts: facts)
            }
        }
    }

    private var buttons: some View {
        HStack(spacing: 6) {
            if let port = group.ports.first {
                // String(port) : un Int dans un libellé serait groupé (« 5 173 »)
                Button("Ouvrir localhost:\(String(port))") { SystemActions.open("http://localhost:\(String(port))") }
                    .glassButton()
                    .help("Ouvrir dans ton navigateur")
            }
            if group.groupState != .app {
                AsyncButton("Arrêter") { await store.stopBackground([group], confirm: true) }
                    .glassButton()
            }
        }
        .controlSize(.small)
        .fixedSize()
    }
}
