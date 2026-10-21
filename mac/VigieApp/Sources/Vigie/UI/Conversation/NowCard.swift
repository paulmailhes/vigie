import SwiftUI

/// « Où ça en est » : le dernier compte rendu de Claude et sa liste de tâches.
struct NowCard: View {
    @Environment(VigieStore.self) private var store
    let summary: ConversationSummary
    let model: ConversationDetailModel?

    var body: some View {
        let now = model?.raw.now
        let tasks = now?.tasks ?? []
        HStack(alignment: .top, spacing: 28) {
            report(now)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !tasks.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("Tâches")
                            .font(.subheadline.weight(.semibold))
                        Spacer(minLength: 6)
                        if let ts = now?.tasksTs {
                            Freshness(date: ts, prefix: "")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    TaskChecklist(tasks: tasks)
                }
                .frame(width: 290, alignment: .leading)
            }
        }
        .padding(.vertical, 4)
    }

    private func report(_ now: NowState?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            // En plein travail : son dernier petit message (« Je relance les tests… »), en direct.
            if let live = now?.live, let text = live.text, !text.isEmpty, summary.state == .working {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Circle().fill(Theme.live).frame(width: 7, height: 7)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(text)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                        if let ts = live.ts {
                            Text("en direct · \(Fmt.ago(ts, now: store.now))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.live.opacity(0.08), in: .rect(cornerRadius: 9))
            }
            if let text = now?.text, !text.isEmpty {
                Text(text)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            } else if model == nil {
                Text("Lecture…").foregroundStyle(.secondary)
            } else {
                Text("Pas encore de compte rendu.").foregroundStyle(.secondary)
            }
            let facts = facts
            if !facts.isEmpty {
                Text(facts.joined(separator: " · "))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }

    /// Quelques faits courts : part de la semaine, agents en cours, limite récente.
    private var facts: [String] {
        var list: [String] = []
        if let pct = summary.weekPct, pct >= 1 { // en dessous de 1 % : du bruit
            let account = store.account(store.runningAccountId(of: summary)).map { " de \($0.displayName)" } ?? ""
            list.append("≈ \(Fmt.pct(pct)) de la semaine\(account)")
        }
        let agents = summary.agentsRunning ?? 0
        if agents > 0 { list.append(Fmt.count(agents, "agent en cours", "agents en cours")) }
        if let hit = model?.raw.limits.first, let ts = hit.ts, store.now.timeIntervalSince(ts) < 5 * 3600 { // la session en cours
            list.append("limite atteinte \(Fmt.when(ts, now: store.now))")
        }
        return list
    }
}

/// Liste de tâches : faites (repliées si nombreuses), en cours, à faire.
struct TaskChecklist: View {
    let tasks: [TaskItem]
    @State private var showDone = false

    var body: some View {
        let done = tasks.filter { $0.state == .done }
        let rest = tasks.filter { $0.state != .done }
        VStack(alignment: .leading, spacing: 5) {
            if done.count > 2 && !showDone {
                Button {
                    withAnimation(.smooth) { showDone = true }
                } label: {
                    Label(Fmt.count(done.count, "faite", "faites"), systemImage: "checkmark.circle")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help("Afficher les tâches faites")
            } else {
                ForEach(Array(done.enumerated()), id: \.offset) { _, task in
                    StepLine(text: task.text ?? "", state: .done)
                }
            }
            ForEach(Array(rest.enumerated()), id: \.offset) { _, task in
                StepLine(text: task.text ?? "", state: task.state)
            }
        }
        .font(.callout)
    }
}

/// Une ligne d'étape ou de tâche : faite (cochée, grisée), en cours (accent, en gras), à faire.
struct StepLine: View {
    let text: String
    let state: TaskStatus

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            switch state {
            case .done:
                Image(systemName: "checkmark.circle").foregroundStyle(.secondary)
                Text(text).foregroundStyle(.secondary)
            case .doing:
                Image(systemName: "arrowtriangle.right.circle.fill").foregroundStyle(.primary)
                Text(text).bold()
            case .todo:
                Image(systemName: "circle").foregroundStyle(.tertiary)
                Text(text)
            }
        }
        .lineLimit(2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(text), \(Self.stateLabel(state))")
    }

    static func stateLabel(_ state: TaskStatus) -> String {
        switch state {
        case .done: "faite"
        case .doing: "en cours"
        case .todo: "à faire"
        }
    }
}

/// Le plan en plusieurs étapes : progression, étape en cours bien visible, étapes suivantes, faites repliées.
struct PlanView: View {
    let plan: WorkPlan
    @State private var showDone = false
    @State private var showAllNext = false

    private static let nextShown = 6

    private typealias Indexed = (index: Int, step: PlanStep)

    var body: some View {
        let done = plan.doneCount
        let total = plan.totalCount
        let currentIndex = plan.currentIndex
        let indexed: [Indexed] = plan.steps.enumerated().map { ($0.offset, $0.element) }
        let next = indexed.filter { $0.step.state != .done && $0.index != currentIndex }
        let finished = indexed.filter { $0.step.state == .done }
        let current = currentIndex.map { plan.steps[$0] }

        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("\(Fmt.int(done)) sur \(Fmt.int(total))")
                        .font(.title3.bold())
                        .monospacedDigit()
                    Text(total > 1 ? "étapes faites" : "étape faite")
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    if let file = plan.file, !file.isEmpty {
                        Button("Ouvrir le plan", systemImage: "doc.text") {
                            SystemActions.openInVSCode(path: file)
                        }
                        .buttonStyle(.borderless)
                        .help(Fmt.shortPath(file))
                    }
                }
                ProgressView(value: Double(min(done, total)), total: Double(max(total, 1)))
                    .progressViewStyle(.linear)
                    .tint(.secondary)
                    .accessibilityLabel("\(done) étapes faites sur \(total)")
            }

            if let current {
                currentStep(current)
            }

            if !next.isEmpty {
                let shown = showAllNext ? next : Array(next.prefix(Self.nextShown))
                VStack(alignment: .leading, spacing: 5) {
                    Text("À suivre")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                    stepList(shown, skipFirstHeaderIf: current?.group)
                    if !showAllNext && next.count > Self.nextShown {
                        ShowAllButton(count: next.count) { withAnimation(.smooth) { showAllNext = true } }
                    }
                }
            }

            if !finished.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    Button {
                        withAnimation(.smooth) { showDone.toggle() }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "chevron.right")
                                .font(.caption.bold())
                                .rotationEffect(.degrees(showDone ? 90 : 0))
                            Label(Fmt.count(finished.count, "faite", "faites"), systemImage: "checkmark.circle")
                        }
                        .foregroundStyle(.secondary)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .help(showDone ? "Replier les étapes faites" : "Afficher les étapes faites")
                    if showDone {
                        stepList(finished, skipFirstHeaderIf: nil)
                            .padding(.leading, 18)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func currentStep(_ step: PlanStep) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            Image(systemName: "arrowtriangle.right.circle.fill")
                .foregroundStyle(.primary)
            VStack(alignment: .leading, spacing: 2) {
                Text(step.label)
                    .font(.body.bold())
                    .fixedSize(horizontal: false, vertical: true)
                Text(["En cours", step.group].compactMap { $0 }.joined(separator: " · "))
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(.quaternary.opacity(0.6), in: .rect(cornerRadius: 9))
        .accessibilityElement(children: .combine)
    }

    /// Étapes groupées par `group` (titres de groupe en petit), dans l'ordre du plan.
    private func stepList(_ items: [Indexed], skipFirstHeaderIf skipped: String?) -> some View {
        let groups = Self.runs(items)
        return VStack(alignment: .leading, spacing: 5) {
            ForEach(Array(groups.enumerated()), id: \.offset) { position, run in
                if let group = run.group, !(position == 0 && group == skipped) {
                    Text(group)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.top, position == 0 ? 0 : 4)
                }
                ForEach(run.items, id: \.index) { item in
                    StepLine(text: item.step.label, state: item.step.state)
                }
            }
        }
        .font(.callout)
    }

    /// Suites d'étapes consécutives d'un même groupe.
    private static func runs(_ items: [Indexed]) -> [(group: String?, items: [Indexed])] {
        var result: [(group: String?, items: [Indexed])] = []
        for item in items {
            let group = item.step.group?.isEmpty == false ? item.step.group : nil
            if let last = result.last, last.group == group {
                result[result.count - 1].items.append(item)
            } else {
                result.append((group, [item]))
            }
        }
        return result
    }
}
