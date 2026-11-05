import SwiftUI

/// Le détail ouvert à droite de la page d'une conversation : la page reste visible et à jour à côté ; Échap le ferme,
/// un autre clic en remplace le contenu.
struct ConversationInspector: View {
    @Environment(VigieStore.self) private var store
    let panel: ConversationPanel
    let summary: ConversationSummary
    let model: ConversationDetailModel?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let model {
                    content(model)
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .toolbar {
            ToolbarItem {
                Button("Fermer", systemImage: "xmark") { store.conversationPanel = nil }
                    .help("Fermer le détail (Échap)")
            }
        }
    }

    @ViewBuilder
    private func content(_ model: ConversationDetailModel) -> some View {
        let detail = model.raw
        switch panel {
        case .request:
            header("Ta demande", detail.current?.start.map { Fmt.when($0, now: store.now) })
            if let current = detail.current {
                MarkdownBlocks(text: current.text ?? current.prompt ?? "")
                if let relaunch = current.relaunch, let ts = relaunch.ts {
                    note("Relancée par « \(relaunch.prompt ?? "") » \(Fmt.when(ts, now: store.now)).")
                }
            }
        case .message(let index):
            if detail.messages.indices.contains(index) {
                let message = detail.messages[index]
                header(message.isReport ? "Compte rendu de Claude" : "Message de Claude", message.ts.map { Fmt.when($0, now: store.now) })
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
            header("Tous les échanges", Fmt.count(detail.chapters.count, "demande"))
            ForEach(detail.chapters) { chapter in
                ThreadPair(chapter: chapter)
                Divider()
            }
        case .agent(let id):
            if let agent = (model.runningAgents + model.doneAgents).first(where: { $0.id == id }) {
                AgentDetail(agent: agent, model: model)
            } else {
                note("Cet agent n'est plus dans la conversation.")
            }
        case .workflow(let id):
            if let workflow = detail.workflows.first(where: { $0.id == id }) {
                WorkflowDetail(workflow: workflow, model: model)
            }
        case .plan:
            if let plan = detail.now?.plan, !plan.steps.isEmpty {
                header(plan.title ?? "Plan", plan.file.map(Fmt.shortPath))
                PlanView(plan: plan)
            }
            if let tasks = detail.now?.tasks, !tasks.isEmpty {
                header("Ses tâches pour ta demande", detail.now?.tasksTs.map { Fmt.when($0, now: store.now) })
                TaskChecklist(tasks: tasks)
            }
            if detail.now?.plan?.steps.isEmpty != false, let doc = detail.trackingDoc {
                header("Feuille de route", Fmt.shortPath(doc.path))
                RoadmapView(doc: doc, cwd: summary.cwd, collapsed: true)
            }
        case .tests:
            header("Tests", Fmt.count(model.tests.count, "vérification"))
            rows(model.tests.sorted { ($0.value.outcome == .failed ? 0 : 1) < ($1.value.outcome == .failed ? 0 : 1) }.prefix(80).map { $0 }) { row in
                TestRow(test: row.value)
            }
        case .files:
            header("Fichiers", Fmt.count(model.files.count, "fichier"))
            if !model.artifacts.isEmpty {
                section("Publié sur claude.ai")
                rows(Array(model.artifacts.prefix(10))) { ArtifactRow(artifact: $0.value) }
            }
            ForEach(model.filesByLocation, id: \.0) { location, items in
                section(Theme.title(for: location))
                rows(Array(items.prefix(60))) { FileRow(file: $0.value, cwd: summary.cwd) }
            }
        case .journal:
            header("Journal", "ses actions, et qui a décidé")
            rows(Array(model.feed.prefix(150))) { AcceptedRow(item: $0.value) }
        case .mcp:
            header("MCP", "leur état pour son dossier et son compte")
            VStack(alignment: .leading, spacing: 8) {
                ConversationMCPList(model: model, cwd: summary.cwd)
            }
        case .background:
            header("En fond", "ce qu'elle a laissé tourner")
            if detail.processes.isEmpty && detail.background.isEmpty {
                note("Rien ne tourne en fond pour elle.")
            }
            ForEach(detail.processes) { group in
                ProcessLine(group: group)
            }
            if !detail.background.isEmpty {
                section("Commandes lancées en fond")
                ForEach(detail.background) { command in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(command.description ?? "Commande")
                        if let text = command.command {
                            Text(text).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                        if let start = command.startedAt {
                            Text("depuis \(Fmt.age(since: start, now: store.now))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            Button("Ouvrir En fond") { store.route = .background }
                .buttonStyle(.link)
        case .answers:
            header("Pour toi", "ce que Vigie a choisi ou noté pour cette conversation")
            let items = store.toReview.filter { $0.conversationId == summary.id && !$0.needsDecision && $0.reviewKind != .waiting }
            ForEach(items) { item in
                ReviewRow(item: item, inConversation: true)
                Divider()
            }
        }
    }

    private func header(_ title: String, _ subtitle: String?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.title3.bold()).fixedSize(horizontal: false, vertical: true)
            if let subtitle, !subtitle.isEmpty {
                Text(subtitle).font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    private func section(_ title: String) -> some View {
        Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.top, 4)
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

/// Une demande et ce qu'elle a donné, dans « Tous les échanges ».
struct ThreadPair: View {
    @Environment(VigieStore.self) private var store
    let chapter: Chapter

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Toi · \(chapter.start.map { Fmt.when($0, now: store.now) } ?? "")")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.you)
                Spacer()
                if let duration = chapter.durationMs, duration > 60_000 {
                    Text(Fmt.duration(ms: duration)).font(.caption).foregroundStyle(.secondary)
                }
            }
            Text(chapter.prompt ?? "").lineLimit(3).textSelection(.enabled)
            if let outcome = chapter.outcome, !outcome.isEmpty {
                Text("Claude").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text(outcome).lineLimit(4).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if let stats = chapter.stats {
                let facts = [stats.commits.flatMap { $0 > 0 ? Fmt.count($0, "commit") : nil },
                             stats.files.flatMap { $0 > 0 ? Fmt.count($0, "fichier") : nil },
                             stats.agents.flatMap { $0 > 0 ? Fmt.count($0, "agent") : nil },
                             stats.workflows.flatMap { $0 > 0 ? Fmt.count($0, "workflow") : nil }].compactMap { $0 }
                if !facts.isEmpty {
                    Text(facts.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .font(.callout)
    }
}

/// La petite page d'un agent : ce qu'on lui a demandé, ce qu'il fait, son résultat, le temps et sa base, ses actions.
struct AgentDetail: View {
    @Environment(VigieStore.self) private var store
    let agent: AgentRun
    let model: ConversationDetailModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                Text(agent.name ?? agent.title ?? "Agent").font(.title3.bold()).fixedSize(horizontal: false, vertical: true)
                Text(["Agent", agent.phase, agent.title, agent.workflow].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · "))
                    .font(.callout).foregroundStyle(.secondary)
            }
            if let prompt = agent.prompt, !prompt.isEmpty {
                block("Ce qu'on lui a demandé") { Text(prompt).textSelection(.enabled) }
            }
            if agent.status == "running" {
                block("En ce moment") {
                    Text("▸ \(agent.lastAction ?? "démarre")\(agent.lastAt.map { " · \(Fmt.ago($0, now: store.now))" } ?? "")")
                }
            } else {
                block(agent.status == "failed" ? "En échec" : "Résultat") {
                    Text(agent.result ?? (agent.status == "failed" ? "Il s'est arrêté sans résultat." : "Pas de résultat lu."))
                        .textSelection(.enabled)
                }
            }
            block("Temps") {
                VStack(alignment: .leading, spacing: 2) {
                    Text(timeLine)
                    if let estimate = agent.estimate, let median = estimate.medianMs, let basis = estimate.basis {
                        Text("Base : médiane de \(Fmt.duration(ms: median)) sur les \(basis) agents « \(agent.phase ?? "") » finis.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            let actions = model.raw.activity.filter { $0.agent == agent.title }.prefix(10)
            if !actions.isEmpty {
                block("Ses dernières actions") {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(actions.enumerated()), id: \.offset) { _, action in
                            HStack(alignment: .firstTextBaseline) {
                                Text(action.title ?? "Action").lineLimit(1)
                                if let ok = action.ok {
                                    Text(ok ? "réussi" : "échoué").font(.caption).foregroundStyle(ok ? Theme.live : Theme.alert)
                                }
                                Spacer(minLength: 6)
                                Text(action.ts.map(Fmt.time) ?? "").font(.caption).foregroundStyle(.secondary).monospacedDigit()
                            }
                        }
                    }
                }
            }
            let counts = [agent.actions.flatMap { $0 > 0 ? Fmt.count($0, "action") : nil },
                          agent.files.flatMap { $0 > 0 ? Fmt.count($0, "fichier") : nil },
                          agent.tests.flatMap { $0 > 0 ? Fmt.count($0, "test") : nil }].compactMap { $0 }
            if !counts.isEmpty {
                Text(counts.joined(separator: " · ")).font(.callout).foregroundStyle(.secondary)
            }
        }
        .font(.callout)
    }

    private var timeLine: String {
        guard let start = agent.startedAt else { return Fmt.duration(ms: agent.durationMs) }
        if agent.status == "running" {
            var text = "depuis \(Fmt.age(since: start, now: store.now))"
            if let ends = agent.estimate?.endsAt, ends > store.now, agent.estimate?.longer != true {
                text += " · reste ≈ \(Fmt.duration(ms: max(5, (ends.timeIntervalSince(store.now) / 60 / 5).rounded() * 5) * 60_000))"
            } else if agent.estimate != nil {
                text += " · plus long que les autres"
            }
            return text
        }
        return "a pris \(Fmt.duration(ms: agent.durationMs)) · fini \(agent.lastAt.map { Fmt.when($0, now: store.now) } ?? "")"
    }

    private func block<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title.uppercased()).font(.caption.weight(.semibold)).foregroundStyle(.secondary).tracking(0.5)
            content()
        }
    }
}

/// La page d'un workflow : ses phases et leurs compteurs, ses agents par phase, sa dernière ligne de journal, son
/// résultat.
struct WorkflowDetail: View {
    @Environment(VigieStore.self) private var store
    let workflow: Workflow
    let model: ConversationDetailModel

    var body: some View {
        let mine = (model.runningAgents + model.doneAgents).filter { $0.workflow == (workflow.name ?? workflow.id) }
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                Text(workflow.name ?? workflow.id).font(.title3.bold())
                Text(["Workflow", status, workflow.startedAt.map { "lancé \(Fmt.when($0, now: store.now))" }, Fmt.duration(ms: workflow.durationMs)]
                    .compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · "))
                    .font(.callout).foregroundStyle(.secondary)
            }
            if let result = workflow.result ?? workflow.summary {
                Text(result).textSelection(.enabled)
            }
            if let log = workflow.lastLog {
                Text("Journal : \(log)").font(.callout).foregroundStyle(.secondary)
            }
            ForEach(phases(mine), id: \.title) { phase in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(phase.title).font(.headline)
                        Spacer()
                        Text(phase.line).font(.callout).foregroundStyle(.secondary)
                    }
                    ForEach(phase.agents) { agent in
                        AgentTile(agent: agent) { panel in
                            store.conversationPanel = panel
                        }
                    }
                }
            }
        }
        .font(.callout)
    }

    private var status: String {
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

/// Un groupe de processus laissé en fond, dans le détail d'une conversation.
struct ProcessLine: View {
    @Environment(VigieStore.self) private var store
    let group: BackgroundGroup

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(group.label ?? "Commande").fontWeight(.medium)
                Text([group.detail, Fmt.memory(mb: group.memoryMb), group.startedAt.map { "depuis \(Fmt.age(since: $0, now: store.now))" }]
                    .compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 6)
            if group.groupState != .app {
                AsyncButton("Arrêter") { await store.stopBackground([group], confirm: true) }
                    .glassButton()
            }
        }
        .font(.callout)
    }
}
