import AppKit
import SwiftUI

/// Tes lancements d'agents (page Agents) : pour chacun, le rapport que l'agent tient à jour — en cours ou terminé, le
/// verdict, ce qu'il a fait, ce qui te reste à faire (à cocher), le rapport détaillé et la conversation.
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
            SectionHeader("Tes lancements", count: runs.count,
                          note: "Le rapport de chaque agent : où il en est, ce qu'il a fait, ce qui te reste à faire.",
                          inset: 0)
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
        case .todo(let n): "\(n) à faire"
        case .blocked: "Bloquant"
        case .stopped: "Arrêté"
        }
    }

    /// Le même repère « travaille » que partout (vert, éclair) : `circle.dashed` voulait dire « fermée ».
    var symbol: String {
        switch self {
        case .running: Theme.symbol(for: .working)
        case .ready: "checkmark.circle.fill"
        case .todo: "exclamationmark.circle.fill"
        case .blocked: "xmark.octagon.fill"
        case .stopped: "pause.circle.fill"
        }
    }

    /// Couleur de remplissage (rond, icône).
    var color: Color {
        switch self {
        case .running, .ready: Theme.live
        case .todo, .stopped: Theme.warn
        case .blocked: Theme.alert
        }
    }

    /// Le ton de sa puce.
    var tone: Chip.Tone {
        switch self {
        case .running, .ready: .live
        case .todo, .stopped: .warn
        case .blocked: .alert
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
            .accessibilityLabel("\(project), \(run.displayName) : \(state.label)")
            .accessibilityHint(expanded ? "Referme le rapport" : "Ouvre le rapport")
            if expanded {
                details
                    .padding(.leading, 40)
                    .transition(.opacity)
            }
        }
        .padding(.vertical, 6)
    }

    /// Le projet, nommé comme partout ailleurs (« Portail/back »).
    private var project: String { ProjectName.display(run.project, cwd: run.folder) }

    private func header(_ state: RecipeRunState) -> some View {
        HStack(alignment: .top, spacing: 12) {
            AgentIcon(symbol: run.icon)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(project)
                        .textRole(.item)
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
            Chip(state.label, symbol: state.symbol, tone: state.tone)
            Image(systemName: "chevron.right")
                .rotationEffect(.degrees(expanded ? 90 : 0))
                .foregroundStyle(.tertiary)
                .padding(.top, 3)
                .accessibilityHidden(true)
        }
        .contentShape(Rectangle())
    }

    private func subtitle(_ state: RecipeRunState) -> String {
        let when = Fmt.when(run.changedAt ?? run.at, now: store.now)
        if let verdict = run.report?.verdict { return "\(verdict) · \(when)" }
        if run.unreadable == true { return "Rapport illisible pour l'instant · \(when)" }
        return state == .running ? "L'agent travaille · lancé \(Fmt.when(run.at, now: store.now))" : when
    }

    @ViewBuilder
    private var details: some View {
        let report = run.report
        VStack(alignment: .leading, spacing: 12) {
            if let counts = report?.counts, (counts.ok ?? 0) + (counts.warn ?? 0) + (counts.block ?? 0) > 0 {
                HStack(spacing: 8) {
                    Chip(Fmt.count(counts.ok ?? 0, "conforme"), symbol: "checkmark.circle.fill", tone: .live)
                    Chip(Fmt.count(counts.warn ?? 0, "à corriger", "à corriger"), symbol: "exclamationmark.circle.fill", tone: .warn)
                    Chip(Fmt.count(counts.block ?? 0, "bloquant"), symbol: "xmark.octagon.fill", tone: .alert)
                }
            }
            if let next = report?.next, !next.isEmpty, report?.isRunning == false {
                // même taille que « Lancer… » (deux actions principales de la page) ; ils passent à la ligne
                WrapLayout(spacing: 8) {
                    ForEach(next) { step in
                        AsyncButton(step.label, systemImage: "wand.and.stars") { await store.sendToRun(run, step) }
                            .glassButton(.primary)
                            .help("Envoie à l'agent, dans sa conversation : « \(step.message) »")
                    }
                }
            }
            if let todo = report?.todo, !todo.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    CardTitle("À faire de ton côté")
                    ForEach(todo) { item in todoRow(item) }
                }
            }
            if let done = report?.done, !done.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    CardTitle("Fait par l'agent")
                    ForEach(Array(done.prefix(8).enumerated()), id: \.offset) { _, line in
                        Label(line, systemImage: "checkmark")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .labelStyle(TightLabel())
                    }
                    if done.count > 8 {
                        Text("et \(done.count - 8) autres, dans le rapport détaillé")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            actions
        }
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
            .accessibilityLabel(item.done ? "Fait : \(item.text)" : "À faire : \(item.text)")
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

    /// Ce qui sort de Vigie le dit (« Ouvrir dans … ») ; « Retirer » ne retire que de la liste. Fenêtre étroite : les
    /// liens passent à la ligne.
    private var actions: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 14) {
                links
                Spacer(minLength: 8)
                remove
            }
            WrapLayout(spacing: 14) {
                links
                remove
            }
        }
        .buttonStyle(.link)
        .font(.callout)
    }

    private var remove: some View {
        AsyncButton("Retirer", systemImage: "xmark") { await store.hideAgentRun(run) }
            .help("Retire ce lancement de la liste ; son rapport reste dans le dossier du projet")
    }

    @ViewBuilder
    private var links: some View {
        Group {
            if let path = run.report?.report {
                Button("Rapport détaillé", systemImage: "doc.text") {
                    NSWorkspace.shared.open(URL(filePath: (run.folder as NSString).appendingPathComponent(path)))
                }
                .help("Ouvre le rapport dans son app")
            }
            ForEach(run.report?.links ?? []) { link in
                if let url = URL(string: link.url) {
                    Link(destination: url) { Label(link.label, systemImage: "arrow.up.right.square") }
                        .help("Ouvrir dans ton navigateur")
                }
            }
            if let conversation = run.conversation {
                AsyncButton(store.conversation(conversation)?.openLabel ?? "Ouvrir dans VS Code",
                            systemImage: "bubble.left.and.text.bubble.right") {
                    await store.openConversationInVSCode(conversation, cwd: run.folder)
                }
                .help("La conversation de l'agent")
            }
            Button("Ouvrir dans le Finder", systemImage: "folder") {
                NSWorkspace.shared.open(URL(filePath: run.folder, directoryHint: .isDirectory))
            }
            .help("Le dossier du projet")
        }
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
