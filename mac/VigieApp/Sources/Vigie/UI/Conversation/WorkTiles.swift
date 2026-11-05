import SwiftUI

/// Une petite tuile : un titre en petit, son chiffre à droite, puis quelques lignes. Un clic ouvre le détail.
struct SmallTile<Content: View>: View {
    var title: String
    var trailing: String?
    var tone: ConversationVerdict.Tone = .calm
    var action: (() -> Void)?
    @ViewBuilder var content: Content

    var body: some View {
        let tile = VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(tone == .alert ? AnyShapeStyle(Theme.alert) : AnyShapeStyle(.secondary))
                    .lineLimit(1)
                Spacer(minLength: 6)
                if let trailing {
                    Text(trailing)
                        .font(.callout)
                        .monospacedDigit()
                        .foregroundStyle(tone == .alert ? AnyShapeStyle(Theme.alert) : AnyShapeStyle(.secondary))
                }
            }
            content
        }
        .font(.callout)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tone == .alert ? AnyShapeStyle(Theme.alert.opacity(0.08)) : AnyShapeStyle(.quinary), in: .rect(cornerRadius: Theme.corner))
        if let action {
            Button(action: action) { tile.contentShape(.rect) }
                .buttonStyle(.plain)
        } else {
            tile
        }
    }
}

/// La colonne de côté : deux tuiles au plus, ce qui cloche d'abord (tests rouges, commande de fond), puis le plan
/// (sinon les tâches, sinon la feuille de route), puis ce qui a été publié.
struct SideTiles: View {
    @Environment(VigieStore.self) private var store
    let model: ConversationDetailModel
    let open: (ConversationPanel) -> Void

    enum Kind: Hashable { case tests, commands, plan, tasks, roadmap, published }

    var body: some View {
        VStack(spacing: 10) {
            ForEach(Self.kinds(model, now: store.now).prefix(2), id: \.self) { kind in
                tile(kind)
            }
        }
    }

    static func kinds(_ model: ConversationDetailModel, now: Date) -> [Kind] {
        var list: [Kind] = []
        if redTest(model, now: now) != nil { list.append(.tests) }
        if !commands(model, now: now).isEmpty { list.append(.commands) }
        let detail = model.raw
        if let plan = detail.now?.plan, !plan.steps.isEmpty,
           plan.doneCount < plan.totalCount || now.timeIntervalSince(plan.updatedAt ?? .distantPast) < 3600 {
            list.append(.plan)
        } else if let tasks = detail.now?.tasks, !tasks.isEmpty, tasks.contains(where: { $0.state != .done }) {
            list.append(.tasks)
        } else if let doc = detail.trackingDoc, now.timeIntervalSince(doc.updatedAt ?? .distantPast) < 86_400 {
            list.append(.roadmap)
        }
        if published(model, now: now) != nil { list.append(.published) }
        return list
    }

    /// Le dernier test : rouge depuis moins de 2 h, sans réussite depuis.
    static func redTest(_ model: ConversationDetailModel, now: Date) -> TestRun? {
        guard let last = model.tests.map(\.value).first(where: { $0.outcome != .pending && $0.outcome != .unknown }),
              last.outcome == .failed, now.timeIntervalSince(last.ts ?? .distantPast) < 7200 else { return nil }
        return last
    }

    /// Une commande de fond qui tourne depuis plus d'une minute.
    static func commands(_ model: ConversationDetailModel, now: Date) -> [BackgroundCommand] {
        model.raw.background.filter { now.timeIntervalSince($0.startedAt ?? now) > 60 }
    }

    static func published(_ model: ConversationDetailModel, now: Date) -> Artifact? {
        let start = model.raw.current?.start ?? .distantPast
        return model.artifacts.map(\.value).first { ($0.ts ?? .distantPast) >= start && now.timeIntervalSince($0.ts ?? .distantPast) < 7200 }
    }

    @ViewBuilder
    private func tile(_ kind: Kind) -> some View {
        let detail = model.raw
        switch kind {
        case .tests:
            if let test = Self.redTest(model, now: store.now) {
                SmallTile(title: redTitle(test), trailing: test.ts.map { "depuis \(Fmt.time($0))" }, tone: .alert, action: { open(.tests) }) {
                    Text(test.title ?? "Tests").lineLimit(1)
                    if let line = test.line, !line.isEmpty {
                        Text(line).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                    }
                    if let by = test.by { Text("par \(by)").foregroundStyle(.secondary).lineLimit(1) }
                }
            }
        case .commands:
            let list = Self.commands(model, now: store.now)
            if let first = list.first {
                SmallTile(title: "Commande de fond", trailing: first.startedAt.map { "depuis \(Fmt.age(since: $0, now: store.now))" },
                          action: { open(.background) }) {
                    Text(first.description ?? "Commande").lineLimit(1)
                    if let command = first.command {
                        Text(command).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    }
                    if list.count > 1 { Text("+\(list.count - 1) autres").foregroundStyle(.secondary) }
                }
            }
        case .plan:
            if let plan = detail.now?.plan {
                SmallTile(title: plan.title.map { Self.cleanTitle($0) } ?? "Plan", trailing: "\(plan.doneCount)/\(plan.totalCount)",
                          action: { open(.plan) }) {
                    ProgressView(value: Double(min(plan.doneCount, plan.totalCount)), total: Double(max(plan.totalCount, 1)))
                        .progressViewStyle(.linear)
                        .tint(.secondary)
                    if let index = plan.currentIndex {
                        Text("▸ \(plan.steps[index].label)").lineLimit(1)
                        if let next = plan.steps.dropFirst(index + 1).first(where: { $0.state != .done }) {
                            Text("Ensuite : \(next.label)").foregroundStyle(.secondary).lineLimit(1)
                        }
                    } else if plan.doneCount >= plan.totalCount {
                        Text("✓ fini\((plan.progressAt ?? plan.updatedAt).map { " à \(Fmt.time($0))" } ?? "")").foregroundStyle(.secondary)
                    }
                    if let task = detail.now?.tasks.first(where: { $0.state == .doing })?.text {
                        let tasks = detail.now?.tasks ?? []
                        Text("Tâches \(tasks.count { $0.state == .done })/\(tasks.count) · \(task)").foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
        case .tasks:
            let tasks = detail.now?.tasks ?? []
            SmallTile(title: "Ses tâches", trailing: "\(tasks.count { $0.state == .done })/\(tasks.count)", action: { open(.plan) }) {
                if let doing = tasks.first(where: { $0.state == .doing }) ?? tasks.first(where: { $0.state == .todo }) {
                    Text("▸ \(doing.text ?? "")").lineLimit(2)
                }
            }
        case .roadmap:
            if let doc = detail.trackingDoc {
                SmallTile(title: (doc.path as NSString).lastPathComponent, trailing: doc.updatedAt.map { Fmt.ago($0, now: store.now) },
                          action: { open(.plan) }) {
                    Text(Self.roadmapLine(doc)).lineLimit(2).foregroundStyle(.secondary)
                }
            }
        case .published:
            if let artifact = Self.published(model, now: store.now) {
                SmallTile(title: "Publié", trailing: artifact.ts.map(Fmt.time)) {
                    HStack {
                        Text(artifact.title ?? "Rapport").lineLimit(1)
                        Spacer(minLength: 6)
                        if let url = artifact.url, !url.isEmpty {
                            Button("Ouvrir") { SystemActions.open(url) }.glassButton()
                        }
                    }
                }
            }
        }
    }

    private func redTitle(_ test: TestRun) -> String {
        if let failed = test.failed, failed > 0 { return "\(Fmt.count(failed, "test rouge", "tests rouges"))" }
        return "Tests rouges"
    }

    /// « Plan 1.4 — refonte » → « Plan 1.4 — refonte », sans le # ni le « Plan : ».
    static func cleanTitle(_ title: String) -> String {
        String(title.replacing(/^#+\s*/, with: "").prefix(36))
    }

    /// La 1re phrase de « où on en est » (ou de son introduction).
    static func roadmapLine(_ doc: TrackingDoc) -> String {
        let key = /(où on en est|ou on en est|état|etat|statut|en cours|suite)/.ignoresCase()
        let text = doc.sections.first { $0.title.contains(key) }?.text ?? doc.intro ?? doc.sections.first?.text ?? ""
        let line = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty && !$0.hasPrefix("#") } ?? ""
        return String(line.replacing(/^[-*>\s]+/, with: "").prefix(140))
    }
}

// MARK: Au travail : workflows et agents

/// Un agent, en 4 lignes : nom lisible (l'étape du plan), sa phase et ce qu'on lui a demandé, ce qu'il fait (ou ce
/// qu'il a rendu), depuis quand et, quand c'est honnête, combien il lui reste.
struct AgentTile: View {
    @Environment(VigieStore.self) private var store
    let agent: AgentRun
    let open: (ConversationPanel) -> Void

    /// Rien écrit depuis 6 min : orange.
    static let quiet: TimeInterval = 6 * 60

    var body: some View {
        Button { open(.agent(agent.id)) } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if agent.status == "failed" {
                        Image(systemName: "xmark").font(.caption.bold()).foregroundStyle(Theme.alert)
                    } else {
                        Circle().fill(dot).frame(width: 7, height: 7)
                    }
                    Text(agent.name ?? agent.title ?? "Agent")
                        .fontWeight(.semibold)
                        .foregroundStyle(agent.status == "failed" ? AnyShapeStyle(Theme.alert) : AnyShapeStyle(.primary))
                        .lineLimit(1)
                }
                Text(asked).foregroundStyle(.secondary).lineLimit(1)
                Text(doing).foregroundStyle(.secondary).lineLimit(1)
                Text(timing)
                    .foregroundStyle(silent ? AnyShapeStyle(Theme.warn) : AnyShapeStyle(.secondary))
                    .monospacedDigit()
                    .lineLimit(1)
            }
            .font(.callout)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.background.opacity(0.7), in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(agent.status == "failed" ? AnyShapeStyle(Theme.alert.opacity(0.5)) : AnyShapeStyle(.quaternary)))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help(agent.title ?? "")
    }

    private var running: Bool { agent.status == "running" }
    private var silent: Bool { running && store.now.timeIntervalSince(agent.lastAt ?? store.now) > Self.quiet }

    private var dot: Color {
        if !running { return Color.secondary.opacity(0.6) }
        return silent ? Theme.warn : Theme.live
    }

    private var asked: String {
        let prompt = agent.prompt.map { $0.prefix(1).lowercased() + $0.dropFirst() }
        return [agent.phase, prompt ?? agent.workflow].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
    }

    private var doing: String {
        if running { return agent.lastAction.map { "▸ \($0)" } ?? "▸ démarre" }
        if agent.status == "failed" { return agent.result ?? "en échec" }
        return agent.result ?? agent.lastAction ?? "fini"
    }

    private var timing: String {
        if running {
            guard let start = agent.startedAt else { return "en cours" }
            if silent, let last = agent.lastAt { return "rien écrit depuis \(Fmt.age(since: last, now: store.now))" }
            var text = "depuis \(Fmt.age(since: start, now: store.now))"
            if let estimate = agent.estimate, let ends = estimate.endsAt {
                if estimate.longer == true || ends <= store.now {
                    text += " · plus long que les autres"
                } else {
                    let minutes = max(5, Int((ends.timeIntervalSince(store.now) / 60 / 5).rounded()) * 5)
                    text += " · reste ≈ \(Fmt.duration(ms: Double(minutes) * 60_000))"
                }
            }
            return text
        }
        let duration = Fmt.duration(ms: agent.durationMs)
        if agent.status == "failed" { return "en échec\(agent.lastAt.map { " à \(Fmt.time($0))" } ?? "")" }
        return duration.isEmpty ? "fini" : "fini · \(duration)"
    }
}

/// Un workflow : son nom et ses phases, l'avancée de ses agents (une barre, un segment par agent), puis ses agents en
/// cours ; fini, la 1re phrase de son résultat.
struct WorkflowTile: View {
    @Environment(VigieStore.self) private var store
    let workflow: Workflow
    let agents: [AgentRun]
    let open: (ConversationPanel) -> Void

    private static let shownAgents = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { open(.workflow(workflow.id)) } label: {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline) {
                        (Text("Workflow ").foregroundStyle(.secondary) + Text(workflow.name ?? workflow.id).bold()
                            + Text(workflow.phases.isEmpty ? "" : " · " + workflow.phases.joined(separator: " → ")).foregroundStyle(.secondary))
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        Text(trailing)
                            .foregroundStyle(failed ? AnyShapeStyle(Theme.alert) : AnyShapeStyle(.secondary))
                            .monospacedDigit()
                    }
                    if running {
                        HStack {
                            Text(countLine)
                            Spacer(minLength: 8)
                            segments
                        }
                        if agents.isEmpty, let log = workflow.lastLog {
                            Text(log).foregroundStyle(.secondary).lineLimit(1)
                        }
                    } else if let result = workflow.result ?? workflow.summary {
                        Text(result).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            if running && !agents.isEmpty {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 240), spacing: 8)], alignment: .leading, spacing: 8) {
                    ForEach(agents.prefix(Self.shownAgents)) { agent in
                        AgentTile(agent: agent, open: open)
                    }
                }
                if agents.count > Self.shownAgents {
                    Text("+\(agents.count - Self.shownAgents) agents\(oldest.map { " · le plus ancien depuis \($0)" } ?? "")")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .font(.callout)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quinary, in: .rect(cornerRadius: Theme.corner))
    }

    private var running: Bool { workflow.status == "running" }
    private var failed: Bool { workflow.status == "failed" || workflow.status == "killed" }

    private var trailing: String {
        if running { return workflow.startedAt.map { "depuis \(Fmt.age(since: $0, now: store.now))" } ?? "en cours" }
        var parts: [String] = []
        if let agents = workflow.agents { parts.append(Fmt.count(agents, "agent")) }
        if let failedCount = workflow.counts?.failed, failedCount > 0 { parts.append("\(failedCount) en échec") }
        let duration = Fmt.duration(ms: workflow.durationMs)
        if !duration.isEmpty { parts.append(duration) }
        let outcome = workflow.status == "failed" ? "en échec" : workflow.status == "killed" ? "arrêté" : "fini"
        return ([outcome] + parts).joined(separator: " · ")
    }

    /// « 7 finis (1 en échec) · 2 en cours ».
    private var countLine: String {
        let c = workflow.counts
        let done = (c?.done ?? 0) + (c?.failed ?? 0)
        var text = "\(Fmt.count(done, "fini", "finis"))"
        if let failedCount = c?.failed, failedCount > 0 { text += " (\(failedCount) en échec)" }
        if let runningCount = c?.running, runningCount > 0 { text += " · \(runningCount) en cours" }
        return text
    }

    private var segments: some View {
        let c = workflow.counts
        let done = c?.done ?? 0, failedCount = c?.failed ?? 0, runningCount = c?.running ?? 0
        let total = min(done + failedCount + runningCount, 40)
        return HStack(spacing: 2) {
            ForEach(0..<total, id: \.self) { index in
                RoundedRectangle(cornerRadius: 2)
                    .fill(index < done ? AnyShapeStyle(.tertiary) : index < done + failedCount ? AnyShapeStyle(Theme.alert) : AnyShapeStyle(Theme.live))
                    .frame(width: 9, height: 7)
            }
        }
        .accessibilityLabel(countLine)
    }

    private var oldest: String? {
        agents.compactMap(\.startedAt).min().map { Fmt.age(since: $0, now: store.now) }
    }
}

// MARK: Détails

/// Une ligne de puces : Journal, Fichiers, Tests, MCP, En fond, réponses choisies pour toi. Une puce vide disparaît.
struct DetailsBar: View {
    @Environment(VigieStore.self) private var store
    let summary: ConversationSummary
    let model: ConversationDetailModel
    let open: (ConversationPanel) -> Void

    var body: some View {
        HStack(spacing: 6) {
            Text("Détails")
                .font(.callout.weight(.semibold))
                .foregroundStyle(.secondary)
            if !model.feed.isEmpty {
                chip("Journal \(Fmt.int(model.feed.count))", dot: model.feed.contains { $0.value.decisionKind == .blocked || $0.value.decisionKind == .waiting } ? Theme.alert : nil, .journal)
            }
            if !model.files.isEmpty || !model.artifacts.isEmpty {
                chip("Fichiers \(Fmt.int(model.files.count + model.artifacts.count))", .files)
            }
            if !model.tests.isEmpty {
                chip("Tests \(Fmt.int(model.tests.count))", dot: SideTiles.redTest(model, now: store.now) != nil ? Theme.alert : nil, .tests)
            }
            if !model.raw.mcp.isEmpty {
                let broken = model.raw.mcp.contains { ($0.enabled ?? true) && ($0.mcpStatus == .needsAuth || $0.mcpStatus == .failed) }
                chip("MCP \(Fmt.int(model.raw.mcp.count))", dot: broken ? Theme.warn : nil, .mcp)
            }
            if !model.raw.processes.isEmpty || !model.raw.background.isEmpty {
                chip("En fond \(Fmt.int(model.raw.processes.count + model.raw.background.count))", .background)
            }
            let answers = store.toReview.filter { $0.conversationId == summary.id && !$0.needsDecision && $0.reviewKind != .waiting }
            if !answers.isEmpty {
                chip(answers.count > 1 ? "\(answers.count) éléments pour toi" : "1 élément pour toi", .answers)
            }
            Spacer(minLength: 0)
        }
        .font(.callout)
    }

    private func chip(_ text: String, dot: Color? = nil, _ panel: ConversationPanel) -> some View {
        Button { open(panel) } label: {
            HStack(spacing: 5) {
                Text(text)
                if let dot { Circle().fill(dot).frame(width: 6, height: 6) }
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 3)
            .background(.quinary, in: .capsule)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
    }
}
