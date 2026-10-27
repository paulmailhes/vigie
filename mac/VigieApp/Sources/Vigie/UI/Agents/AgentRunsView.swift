import AppKit
import SwiftUI

/// Les derniers lancements d'agents (page Agents) : pour chacun, le rapport que l'agent tient à jour — en cours ou
/// terminé, le verdict, ce qu'il a fait, ce qui reste à valider (à cocher), le rapport détaillé et la conversation.
/// Chaque lancement s'ouvre et se referme ; le plus récent est ouvert. Mis à jour à la seconde (GET /api/v2/changes).
struct RecipeRunsSection: View {
    @Environment(VigieStore.self) private var store
    let runs: [RecipeRun]
    @State private var opened: Set<String>?

    var body: some View {
        Section {
            ForEach(runs) { run in
                RecipeRunRow(run: run, expanded: Binding {
                    (opened ?? Set(runs.prefix(1).map(\.id))).contains(run.id)
                } set: { open in
                    var set = opened ?? Set(runs.prefix(1).map(\.id))
                    if open { set.insert(run.id) } else { set.remove(run.id) }
                    opened = set
                })
            }
        } header: {
            MCPSectionHeader(title: "Derniers lancements",
                             text: "Le rapport de chaque agent : où il en est, ce qu'il a fait, ce qui te reste à valider.")
        }
    }
}

/// Où en est un lancement, en un mot et une couleur.
enum RecipeRunState: Equatable {
    case running, ready, todo(Int), blocked, stopped

    init(_ report: AgentReport?) {
        guard let report else { self = .running; return }
        if report.isBlocked { self = .stopped; return }
        if report.isRunning { self = .running; return }
        let open = report.openTodo
        if report.level == "block" || open.contains(where: { $0.severity == "block" }) { self = .blocked; return }
        self = open.isEmpty ? .ready : .todo(open.count)
    }

    var label: String {
        switch self {
        case .running: "En cours"
        case .ready: "Tout est bon"
        case .todo(let n): n == 1 ? "1 à valider" : "\(n) à valider"
        case .blocked: "Bloquant"
        case .stopped: "Arrêté"
        }
    }

    var symbol: String {
        switch self {
        case .running: "circle.dashed"
        case .ready: "checkmark.circle.fill"
        case .todo: "exclamationmark.circle.fill"
        case .blocked: "xmark.octagon.fill"
        case .stopped: "pause.circle.fill"
        }
    }

    var color: Color {
        switch self {
        case .running: Theme.action
        case .ready: Theme.live
        case .todo, .stopped: Theme.warn
        case .blocked: Theme.alert
        }
    }
}

struct RecipeRunRow: View {
    @Environment(VigieStore.self) private var store
    let run: RecipeRun
    @Binding var expanded: Bool

    var body: some View {
        let state = RecipeRunState(run.report)
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { expanded.toggle() }
            } label: {
                header(state)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(run.displayName), \(run.project) : \(state.label)")
            .accessibilityHint(expanded ? "Referme le rapport" : "Ouvre le rapport")
            if expanded {
                details
                    .padding(.leading, 40)
                    .transition(.opacity)
            }
        }
        .padding(.vertical, 6)
    }

    private func header(_ state: RecipeRunState) -> some View {
        HStack(alignment: .top, spacing: 12) {
            AgentIcon(symbol: run.icon)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(run.project)
                        .fontWeight(.semibold)
                    Text(run.displayName)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Text(subtitle(state))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(expanded ? nil : 1)
                    .fixedSize(horizontal: false, vertical: expanded)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 5) {
                if state == .running {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: state.symbol)
                }
                Text(state.label)
            }
            .font(.callout.weight(.medium))
            .foregroundStyle(state.color)
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(state.color.opacity(0.12), in: .capsule)
            Image(systemName: "chevron.right")
                .rotationEffect(.degrees(expanded ? 90 : 0))
                .foregroundStyle(.tertiary)
                .padding(.top, 5)
        }
        .contentShape(Rectangle())
    }

    private func subtitle(_ state: RecipeRunState) -> String {
        let when = Fmt.when(run.changedAt ?? run.at)
        if let verdict = run.report?.verdict { return "\(verdict) · \(when)" }
        if run.unreadable == true { return "Rapport illisible pour l'instant · \(when)" }
        return state == .running ? "L'agent travaille · lancé \(Fmt.when(run.at))" : when
    }

    @ViewBuilder
    private var details: some View {
        let report = run.report
        VStack(alignment: .leading, spacing: 12) {
            if let counts = report?.counts, (counts.ok ?? 0) + (counts.warn ?? 0) + (counts.block ?? 0) > 0 {
                HStack(spacing: 8) {
                    countChip(counts.ok, "conforme", "conformes", "checkmark.circle.fill", Theme.live)
                    countChip(counts.warn, "à corriger", "à corriger", "exclamationmark.circle.fill", Theme.warn)
                    countChip(counts.block, "bloquant", "bloquants", "xmark.octagon.fill", Theme.alert)
                }
            }
            if let next = report?.next, !next.isEmpty, report?.isRunning == false {
                HStack(spacing: 8) {
                    ForEach(next) { step in
                        AsyncButton(step.label, systemImage: "wand.and.stars") { await store.sendToRun(run, step) }
                            .glassButton(.primary)
                            .controlSize(.small)
                            .help("Envoie à l'agent, dans sa conversation : « \(step.message) »")
                    }
                }
            }
            if let todo = report?.todo, !todo.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("À valider de ton côté")
                        .font(.callout.weight(.semibold))
                    ForEach(todo) { item in todoRow(item) }
                }
            }
            if let done = report?.done, !done.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Fait par l'agent")
                        .font(.callout.weight(.semibold))
                    ForEach(Array(done.prefix(8).enumerated()), id: \.offset) { _, line in
                        Label(line, systemImage: "checkmark")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .labelStyle(TightLabel())
                    }
                    if done.count > 8 {
                        Text("et \(done.count - 8) autres, dans le rapport détaillé")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            actions
        }
    }

    private func countChip(_ value: Int?, _ one: String, _ many: String, _ symbol: String, _ color: Color) -> some View {
        HStack(spacing: 4) {
            Image(systemName: symbol)
                .foregroundStyle(color)
            Text(Fmt.count(value ?? 0, one, many))
        }
        .font(.caption)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(.quaternary, in: .capsule)
    }

    private func todoRow(_ item: AgentTodo) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Button {
                Task { await store.setAgentTodo(run, item, done: !item.done) }
            } label: {
                Image(systemName: item.done ? "checkmark.square.fill" : "square")
                    .foregroundStyle(item.done ? Theme.live : .secondary)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(item.done ? "Fait" : "À faire")
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    if !item.done, let severity = item.severity, severity != "info" {
                        Circle()
                            .fill(severity == "block" ? Theme.alert : Theme.warn)
                            .frame(width: 7, height: 7)
                            .accessibilityLabel(severity == "block" ? "bloquant" : "à corriger")
                    }
                    Text(item.text)
                        .strikethrough(item.done)
                        .foregroundStyle(item.done ? .secondary : .primary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let place = item.where {
                    Text(place)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .font(.callout)
    }

    private var actions: some View {
        HStack(spacing: 14) {
            if let path = run.report?.report {
                Button("Rapport détaillé", systemImage: "doc.text") {
                    NSWorkspace.shared.open(URL(filePath: (run.folder as NSString).appendingPathComponent(path)))
                }
            }
            ForEach(run.report?.links ?? []) { link in
                if let url = URL(string: link.url) {
                    Link(destination: url) { Label(link.label, systemImage: "arrow.up.right.square") }
                }
            }
            if let conversation = run.conversation {
                AsyncButton("Conversation", systemImage: "bubble.left.and.text.bubble.right") {
                    await store.openConversationInVSCode(conversation, cwd: run.folder)
                }
            }
            Button("Dossier", systemImage: "folder") {
                NSWorkspace.shared.open(URL(filePath: run.folder, directoryHint: .isDirectory))
            }
            Spacer()
            AsyncButton("Retirer", systemImage: "xmark") { await store.hideAgentRun(run) }
                .help("Retire ce lancement de la liste ; son rapport reste dans le dossier du projet")
        }
        .buttonStyle(.link)
        .font(.callout)
    }
}

/// Une étiquette serrée (symbole petit, texte sur plusieurs lignes).
private struct TightLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            configuration.icon
                .imageScale(.small)
            configuration.title
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
