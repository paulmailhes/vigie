import SwiftUI

struct EmptyRow: View {
    let text: String

    var body: some View {
        Text(text)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 10)
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
                    .help(item.title ?? "")
                if let detail = item.detail, !detail.isEmpty {
                    if isCode {
                        CodeLine(detail)
                    } else {
                        InfoLine(detail)
                    }
                }
            }
            Spacer(minLength: 8)
            if let label = decision.label {
                Chip(label, tone: decision.alert ? .alert : .neutral)
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

/// Une page publiée sur claude.ai : clic = l'ouvrir dans ton navigateur (on quitte Vigie, comme un fichier s'ouvre
/// dans VS Code) ; clic droit = copier son adresse.
struct ArtifactRow: View {
    @Environment(VigieStore.self) private var store
    let artifact: Artifact

    var body: some View {
        let url = artifact.url ?? ""
        Button {
            SystemActions.open(url)
        } label: {
            HStack(spacing: 10) {
                RowIcon(symbol: Icon.artifact)
                VStack(alignment: .leading, spacing: 2) {
                    Text(artifact.title ?? "Page publiée").lineLimit(2)
                    if let description = artifact.description, !description.isEmpty {
                        InfoLine(description)
                    }
                    let facts: [String?] = [artifact.publishes.flatMap { $0 > 1 ? "publié \($0) fois" : nil },
                                            artifact.ts.map { Fmt.when($0, now: store.now) }]
                    if !InfoLine.text(facts).isEmpty {
                        InfoLine(parts: facts)
                    }
                }
                Spacer(minLength: 8)
                if !url.isEmpty {
                    Image(systemName: "arrow.up.forward.square")
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help(url.isEmpty ? "" : "Ouvrir dans ton navigateur")
        .contextMenu {
            if !url.isEmpty {
                Button("Ouvrir dans ton navigateur", systemImage: "safari") { SystemActions.open(url) }
                Button("Copier l'adresse", systemImage: "doc.on.doc") { SystemActions.copy(url) }
            }
        }
        .padding(.vertical, 2)
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
                    CodeLine(folder)
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
            Button("Afficher dans le Finder", systemImage: "folder") {
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
                    CodeLine(command)
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

    /// « 245 réussis », « 3 en échec sur 248 », « échec attendu », « en cours ».
    private var result: String {
        switch test.outcome {
        case .pending: return "en cours"
        case .unknown: return "résultat inconnu"
        case .expectedFail: return "échec attendu"
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
            RunningMark()
        case .passed:
            RowIcon(symbol: Theme.icon(for: test.testKind))
        case .expectedFail:
            RowIcon(symbol: Icon.testExpectedFail)
        case .unknown:
            RowIcon(symbol: "questionmark.circle")
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
                CardTitle(Theme.title(for: group), compact: true)
                    .padding(.top, 4)
                ForEach(items, id: \.name) { item in
                    row(item)
                }
            }
            Button("Voir la page MCP", systemImage: Icon.mcp) { store.route = .mcp }
                .buttonStyle(.link)
                .padding(.top, 4)
        }
    }

    /// Un MCP coupé : seule son icône s'atténue ; son nom passe en gris et « coupé » reste lisible.
    private func row(_ item: ConversationMCP) -> some View {
        let status = item.enabled == false ? MCPStatus.disabled : item.mcpStatus
        return HStack(spacing: 10) {
            ServiceGlyph(service: item.service, name: item.name)
                .opacity(status == .disabled ? Theme.dim : 1)
            // un objet qu'on ouvre : son nom en semi-gras, comme sur la page MCP
            Text(item.name)
                .textRole(.item)
                .foregroundStyle(status == .disabled ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
            Spacer(minLength: 8)
            if status == .needsAuth {
                Button("Connecter") {
                    let summary = store.conversation(model.raw.summary?.id ?? "")
                    Task { await store.mcpConnect(name: item.name, accountId: summary.flatMap { store.runningAccountId(of: $0) }, path: cwd) }
                }
                .glassButton(.primary)
                .controlSize(.small)
            } else {
                // déjà une couleur de TEXTE (orange ou rouge foncés en mode clair pour un problème, gris sinon)
                Text(MCPStatusStyle.label(status))
                    .font(.callout)
                    .foregroundStyle(MCPStatusStyle.color(status))
            }
            UsesLabel(count: item.uses, here: true)
        }
    }
}
