import SwiftUI

/// Le contenu de l'onglet choisi : d'abord l'essentiel (les plus récents), puis « Tout afficher ».
struct ConversationTabContent: View {
    let tab: ConversationTab
    let model: ConversationDetailModel
    let cwd: String?

    @State private var showAll = false
    @State private var showDoneAgents = false

    /// Combien d'éléments on montre avant « Tout afficher ».
    private static let shown = 8

    var body: some View {
        switch tab {
        case .fil:
            FilView(milestones: model.milestones)

        case .mcp:
            ConversationMCPList(model: model, cwd: cwd)

        case .accepted:
            if model.accepted.isEmpty {
                EmptyRow(text: "Rien de validé pour l'instant")
            } else {
                ForEach(limited(model.accepted)) { row in
                    AcceptedRow(item: row.value)
                }
                more(model.accepted.count)
            }

        case .agents:
            ForEach(model.raw.workflows.filter { $0.status == "running" }) { workflow in
                WorkflowRow(workflow: workflow)
            }
            if model.runningAgents.isEmpty {
                EmptyRow(text: "Aucun agent en cours")
            } else {
                ForEach(limited(model.runningAgents)) { agent in
                    AgentRow(agent: agent)
                }
                more(model.runningAgents.count)
            }
            if !model.doneAgents.isEmpty {
                DisclosureGroup(isExpanded: $showDoneAgents) {
                    ForEach(model.doneAgents) { agent in
                        AgentRow(agent: agent)
                    }
                } label: {
                    Text("Terminés (\(model.doneAgents.count))")
                        .foregroundStyle(.secondary)
                }
            }

        case .files:
            if !model.artifacts.isEmpty {
                Text("Publié sur claude.ai · \(Fmt.int(model.artifacts.count))")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
                ForEach(model.artifacts.prefix(5)) { row in
                    ArtifactRow(artifact: row.value)
                }
            }
            if model.files.isEmpty {
                EmptyRow(text: "Aucun fichier créé ou modifié")
            } else {
                ForEach(filesShown, id: \.0) { location, rows in
                    Text("\(Theme.title(for: location)) · \(Fmt.int(model.filesByLocation.first { $0.0 == location }?.1.count ?? rows.count))")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.top, 2)
                    ForEach(rows) { row in
                        FileRow(file: row.value, cwd: cwd)
                    }
                }
                more(model.files.count)
            }

        case .tests:
            if model.tests.isEmpty {
                EmptyRow(text: "Aucune vérification lancée")
            } else {
                ForEach(limited(model.tests)) { row in
                    TestRow(test: row.value)
                }
                more(model.tests.count)
            }
        }
    }

    private func limited<Item>(_ items: [Item]) -> [Item] {
        showAll ? items : Array(items.prefix(Self.shown))
    }

    @ViewBuilder
    private func more(_ count: Int) -> some View {
        if !showAll && count > Self.shown {
            ShowAllButton(count: count) { withAnimation(.smooth) { showAll = true } }
        }
    }

    /// Fichiers les plus récents d'abord, rangés par lieu, au plus `shown` en tout tant qu'on n'a pas tout demandé.
    private var filesShown: [(FileLocation, [Row<FileItem>])] {
        guard !showAll else { return model.filesByLocation }
        let recent = Set(model.files.prefix(Self.shown).map(\.id))
        return model.filesByLocation.compactMap { location, rows in
            let kept = rows.filter { recent.contains($0.id) }
            return kept.isEmpty ? nil : (location, kept)
        }
    }
}

struct EmptyRow: View {
    let text: String

    var body: some View {
        Text(text)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 10)
    }
}

/// Une demande de l'utilisateur et ce qu'elle a donné.
struct ChapterRow: View {
    @Environment(VigieStore.self) private var store
    let chapter: Chapter
    @State private var expanded = false

    var body: some View {
        let inProgress = chapter.end == nil
        HStack(alignment: .top, spacing: 10) {
            Capsule()
                .fill(inProgress ? AnyShapeStyle(.secondary) : AnyShapeStyle(.quaternary))
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 4) {
                Text("« \(chapter.prompt ?? "Demande") »")
                    .lineLimit(expanded ? nil : 1)
                if let outcome = chapter.outcome, !outcome.isEmpty {
                    Text(outcome)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(expanded ? nil : 1)
                }
                Text(metaLine(inProgress: inProgress))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Button(expanded ? "Réduire" : "Déplier", systemImage: expanded ? "chevron.up" : "chevron.down") {
                withAnimation(.smooth) { expanded.toggle() }
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.borderless)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    /// « hier 22:14 · 21 min · 24 fichiers · 40 tests dont 3 en échec · 6 commits ».
    private func metaLine(inProgress: Bool) -> String {
        var parts: [String] = []
        let start = chapter.start.map { Fmt.when($0, now: store.now) } ?? ""
        let duration = Fmt.duration(ms: chapter.durationMs)
        if !start.isEmpty { parts.append(start) }
        if inProgress {
            parts.append(duration.isEmpty ? "en cours" : "en cours depuis \(duration)")
        } else if !duration.isEmpty {
            parts.append(duration)
        }
        if let stats = chapter.stats {
            if let value = stats.workflows, value > 0 { parts.append(Fmt.count(value, "workflow")) }
            if let value = stats.agents, value > 0 { parts.append(Fmt.count(value, "agent")) }
            if let value = stats.artifacts, value > 0 { parts.append(Fmt.count(value, "rapport")) }
            if let value = stats.files, value > 0 { parts.append(Fmt.count(value, "fichier")) }
            if let value = stats.tests, value > 0 {
                let failed = stats.testsFailed ?? 0
                parts.append(Fmt.count(value, "test") + (failed > 0 ? " dont \(Fmt.int(failed)) en échec" : ""))
            }
            if let value = stats.commits, value > 0 { parts.append(Fmt.count(value, "commit")) }
        }
        return parts.joined(separator: " · ")
    }
}

/// Une décision de Vigie : seules les décisions qui sortent de l'ordinaire portent une étiquette.
struct AcceptedRow: View {
    @Environment(VigieStore.self) private var store
    let item: AcceptedItem

    var body: some View {
        let decision = Theme.decision(item.decisionKind)
        HStack(spacing: 10) {
            ActionIcon(kind: item.itemKind, hint: "\(item.title ?? "") \(item.detail ?? "")", alert: decision.alert)
            VStack(alignment: .leading, spacing: 1) {
                Text(item.title ?? "Action")
                    .lineLimit(1)
                if let detail = item.detail, !detail.isEmpty {
                    Text(detail)
                        .font(isCode ? .caption.monospaced() : .caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: 8)
            if let label = decision.label {
                Pill(text: label, alert: decision.alert)
            }
            TimeText(date: item.ts)
        }
        .accessibilityElement(children: .combine)
    }

    private var isCode: Bool {
        [.command, .commit, .push].contains(item.itemKind)
    }
}

/// Heure d'un élément, alignée à droite.
struct TimeText: View {
    @Environment(VigieStore.self) private var store
    let date: Date?

    var body: some View {
        Text(Fmt.when(date, now: store.now))
            .font(.caption)
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .frame(minWidth: 64, alignment: .trailing)
    }
}

struct WorkflowRow: View {
    let workflow: Workflow

    var body: some View {
        HStack(spacing: 10) {
            RowIcon(symbol: Icon.workflow)
            VStack(alignment: .leading, spacing: 1) {
                Text("Workflow « \(workflow.name ?? workflow.id) »")
                Text([workflow.summary, workflow.phases.isEmpty ? nil : workflow.phases.joined(separator: " → ")]
                    .compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text([workflow.agents.map { Fmt.count($0, "agent") }, Fmt.duration(ms: workflow.durationMs)]
                .compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · "))
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
    }
}

struct AgentRow: View {
    let agent: AgentRun

    var body: some View {
        HStack(spacing: 10) {
            statusIcon
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(agent.title ?? "Agent")
                    if let phase = agent.phase {
                        Pill(text: phase)
                    }
                }
                Text(agent.lastAction ?? agent.workflow ?? "")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text(stats)
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    /// « 44 actions · 3 fichiers · 2 min ».
    private var stats: String {
        var parts: [String] = []
        if let value = agent.actions, value > 0 { parts.append(Fmt.count(value, "action")) }
        if let value = agent.files, value > 0 { parts.append(Fmt.count(value, "fichier")) }
        let duration = Fmt.duration(ms: agent.durationMs)
        if !duration.isEmpty { parts.append(duration) }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch agent.status {
        case "running":
            ProgressView()
                .controlSize(.small)
                .frame(width: 22)
                .accessibilityLabel("En cours")
        case "failed":
            RowIcon(symbol: "xmark.octagon")
        case "killed":
            RowIcon(symbol: "stop.circle")
        case "idle":
            RowIcon(symbol: "pause.circle")
        default:
            RowIcon(symbol: "checkmark.circle")
        }
    }
}

struct ArtifactRow: View {
    @Environment(VigieStore.self) private var store
    let artifact: Artifact

    var body: some View {
        HStack(spacing: 10) {
            RowIcon(symbol: Icon.artifact)
            VStack(alignment: .leading, spacing: 2) {
                Text(artifact.title ?? "Rapport")
                if let description = artifact.description, !description.isEmpty {
                    Text(description)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            Text(footer)
                .font(.caption)
                .foregroundStyle(.secondary)
            if let url = artifact.url, !url.isEmpty {
                Button("Ouvrir") { SystemActions.open(url) }
                    .glassButton()
                    .help("Ouvrir sur claude.ai")
            }
        }
        .padding(.vertical, 2)
    }

    private var footer: String {
        var parts: [String] = []
        if let count = artifact.publishes, count > 1 { parts.append("publié \(count) fois") }
        if let ts = artifact.ts { parts.append(Fmt.when(ts, now: store.now)) }
        return parts.joined(separator: " · ")
    }
}

/// Un fichier : clic = ouvrir dans VS Code ; clic droit = Révéler dans le Finder.
struct FileRow: View {
    let file: FileItem
    let cwd: String?

    var body: some View {
        Button {
            SystemActions.openInVSCode(path: file.path)
        } label: {
            HStack(spacing: 10) {
                RowIcon(symbol: Theme.symbol(for: file.fileKind))
                VStack(alignment: .leading, spacing: 1) {
                    Text(file.displayName).lineLimit(1)
                    Text(folder)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                Text(change)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TimeText(date: file.ts)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help("Ouvrir dans VS Code")
        .contextMenu {
            Button("Ouvrir dans VS Code", systemImage: "chevron.left.forwardslash.chevron.right") {
                SystemActions.openInVSCode(path: file.path)
            }
            Button("Révéler dans le Finder", systemImage: "folder") {
                SystemActions.revealInFinder(path: file.path)
            }
            Divider()
            Button("Copier le chemin", systemImage: "doc.on.doc") {
                SystemActions.copy(file.path)
            }
        }
    }

    private var change: String {
        if file.created == true { return "créé" }
        if let writes = file.writes, writes > 1 { return "modifié \(writes) fois" }
        return "modifié"
    }

    private var folder: String {
        let directory = (file.path as NSString).deletingLastPathComponent
        if let cwd, directory.hasPrefix(cwd) {
            let relative = String(directory.dropFirst(cwd.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            return relative.isEmpty ? (cwd as NSString).lastPathComponent : relative
        }
        return Fmt.shortPath(directory)
    }
}

struct TestRow: View {
    let test: TestRun

    var body: some View {
        HStack(spacing: 10) {
            outcomeIcon
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(test.title ?? Theme.title(for: test.testKind)).lineLimit(1)
                    Text(Theme.title(for: test.testKind))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if test.outcome == .failed, let line = test.line, !line.isEmpty {
                    Text(line)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                } else if let command = test.command {
                    Text(command)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: 8)
            Text(result)
                .font(.caption)
                .fontWeight(test.outcome == .failed ? .semibold : .regular)
                .foregroundStyle(test.outcome == .failed ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                .help(test.outcome == .expectedFail ? "Échec attendu : le test est écrit avant le code" : "")
            TimeText(date: test.ts)
        }
        .accessibilityElement(children: .combine)
    }

    /// « 245 réussis », « 3 en échec sur 248 », « échec voulu », « en cours ».
    private var result: String {
        switch test.outcome {
        case .pending: return "en cours"
        case .expectedFail: return "échec voulu"
        case .passed:
            if let passed = test.passed, passed > 0 { return Fmt.count(passed, "réussi") }
            return "réussi"
        case .failed:
            if let failed = test.failed, failed > 0 {
                let total = failed + (test.passed ?? 0)
                return "\(Fmt.int(failed)) en échec sur \(Fmt.int(total))"
            }
            return "échec"
        }
    }

    @ViewBuilder
    private var outcomeIcon: some View {
        switch test.outcome {
        case .pending:
            ProgressView()
                .controlSize(.small)
                .frame(width: 22)
                .accessibilityLabel("En cours")
        case .passed:
            RowIcon(symbol: Theme.icon(for: test.testKind))
        case .expectedFail:
            RowIcon(symbol: Icon.testExpectedFail)
        case .failed:
            Image(systemName: Icon.testFailed)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(width: 22)
                .accessibilityLabel("Échec")
        }
    }
}

/// Les MCP de la conversation : leur état pour son dossier et son compte, et « Connecter » quand il le faut.
struct ConversationMCPList: View {
    @Environment(VigieStore.self) private var store
    let model: ConversationDetailModel
    let cwd: String?

    var body: some View {
        if model.raw.mcp.isEmpty {
            EmptyRow(text: "Aucun MCP utilisé par cette conversation")
        } else {
            ForEach(model.mcpGroups, id: \.0) { group, items in
                Text(Theme.title(for: group))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
                ForEach(items, id: \.name) { item in
                    row(item)
                }
            }
            Button("Tous les MCP", systemImage: Icon.mcp) { store.route = .mcp }
                .buttonStyle(.link)
                .padding(.top, 4)
        }
    }

    private func row(_ item: ConversationMCP) -> some View {
        let status = item.enabled == false ? MCPStatus.disabled : item.mcpStatus
        return HStack(spacing: 10) {
            ServiceGlyph(service: item.service, name: item.name)
            Text(item.name)
            Spacer(minLength: 8)
            if status == .needsAuth {
                Button("Connecter") {
                    let summary = store.conversation(model.raw.summary?.id ?? "")
                    Task { await store.mcpConnect(name: item.name, accountId: summary.flatMap { store.runningAccountId(of: $0) }, path: cwd) }
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.warn)
                .controlSize(.small)
            } else {
                Text(MCPStatusStyle.label(status))
                    .font(.callout)
                    .foregroundStyle(status == .connected ? AnyShapeStyle(.secondary) : AnyShapeStyle(MCPStatusStyle.color(status)))
            }
            UsesLabel(count: item.uses)
        }
        .opacity(status == .disabled ? Theme.dim : 1)
    }
}
