import AppKit
import SwiftUI

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

    /// Couleur de remplissage (rond, icône). Le vert veut dire « travaille » : « Tout est bon » est gris avec sa coche,
    /// comme les tests réussis.
    var color: Color {
        switch self {
        case .running: Theme.live
        case .ready: .secondary
        case .todo, .stopped: Theme.warn
        case .blocked: Theme.alert
        }
    }

    /// Le ton de sa puce.
    var tone: Chip.Tone {
        switch self {
        case .running: .live
        case .ready: .neutral
        case .todo, .stopped: .warn
        case .blocked: .alert
        }
    }
}

/// Le rapport d'un agent de Vigie, dans le panneau de droite de sa conversation (« Voir le rapport » de la tuile
/// « Agent Vigie ») : où il en est et son verdict, ses décomptes, la suite qu'il propose, ce qui te reste à faire (à
/// cocher), ce qu'il a fait, puis le rapport détaillé, la conversation et le dossier. Le nom de l'agent est le titre du
/// panneau ; le rapport suit le détail de la conversation, relu dès qu'elle avance.
struct AgentReportPanel: View {
    @Environment(VigieStore.self) private var store
    let run: RecipeRun
    let conversationID: String

    /// « Fait par l'agent » : les premières lignes, le reste est dans le rapport détaillé.
    nonisolated static let doneShown = 12

    /// Le titre du panneau : le nom de l'agent (son identifiant au survol), et quand le rapport a changé.
    static func heading(_ run: RecipeRun, now: Date) -> PanelHeading {
        let when = Fmt.when(run.changedAt ?? run.at, now: now)
        return PanelHeading(title: run.displayName,
                            subtitle: InfoLine.text(["Rapport de l'agent", when.isEmpty ? nil : "mis à jour \(when)"]),
                            help: run.agent, titleLines: 2)
    }

    /// La phrase sous l'état : le verdict de l'agent ; sans verdict, ce qu'on sait (illisible, rien d'écrit encore, ou
    /// il travaille). Le rapport de départ du moteur n'a que le nom de l'agent pour titre : « Pas encore de rapport ».
    static func summary(_ run: RecipeRun, now: Date) -> String? {
        if let verdict = run.verdict { return verdict }
        if run.unreadable == true { return "Le rapport est illisible pour l'instant : l'agent est peut-être en train de l'écrire." }
        guard RecipeRunState(run.report) == .running else { return nil }
        let nothingYet = run.report.map { $0.done.isEmpty && $0.todo.isEmpty } ?? true
        let head = nothingYet ? "Pas encore de rapport" : "L'agent travaille"
        let when = Fmt.when(run.at, now: now)
        return when.isEmpty ? "\(head)." : "\(head) · lancé \(when)"
    }

    var body: some View {
        let report = run.report
        let state = RecipeRunState(report)
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Chip(state.label, symbol: state.symbol, tone: state.tone)
                if let line = Self.summary(run, now: store.now) {
                    Text(line)
                        .font(.body)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let counts = report?.counts, (counts.ok ?? 0) + (counts.warn ?? 0) + (counts.block ?? 0) > 0 {
                // le panneau est étroit : les puces passent à la ligne
                WrapLayout(spacing: 6, lineSpacing: 6) {
                    Chip(Fmt.count(counts.ok ?? 0, "conforme"), symbol: "checkmark.circle.fill", tone: .neutral)
                    Chip(Fmt.count(counts.warn ?? 0, "à corriger", "à corriger"), symbol: "exclamationmark.circle.fill", tone: .warn)
                    Chip(Fmt.count(counts.block ?? 0, "bloquant"), symbol: "xmark.octagon.fill", tone: .alert)
                }
            }
            if let next = report?.next, !next.isEmpty, report?.isRunning == false {
                WrapLayout(spacing: 8, lineSpacing: 6) {
                    ForEach(next) { step in
                        AsyncButton(step.label, systemImage: "wand.and.stars") { await store.sendToRun(run, step) }
                            .glassButton(.primary)
                            .help("Envoie à l'agent, dans sa conversation : « \(step.message) »")
                    }
                }
            }
            if let todo = report?.todo, !todo.isEmpty {
                PanelBlock("À toi", trailing: Self.todoLine(todo)) {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(todo) { item in todoRow(item) }
                    }
                }
            }
            if let done = report?.done, !done.isEmpty {
                PanelBlock("Fait par l'agent", trailing: Fmt.count(done.count, "point")) {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(done.prefix(Self.doneShown).enumerated()), id: \.offset) { _, line in
                            Label(line, systemImage: "checkmark")
                                .foregroundStyle(.secondary)
                                .labelStyle(TightLabel())
                        }
                        if done.count > Self.doneShown {
                            Text("et \(done.count - Self.doneShown) autres, dans le rapport détaillé")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            links
            remove
        }
        .font(.callout)
    }

    /// « 1/3 faites » : le chiffre à droite du surtitre.
    nonisolated static func todoLine(_ todo: [AgentTodo]) -> String {
        let done = todo.count { $0.done }
        return "\(Fmt.int(done))/\(Fmt.int(todo.count)) \(todo.count > 1 ? "faites" : "faite")"
    }

    private func todoRow(_ item: AgentTodo) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Button {
                Task { await store.setAgentTodo(run, item, done: !item.done, in: conversationID) }
            } label: {
                // la case pleine suffit : pas de vert (il veut dire « travaille »)
                Image(systemName: item.done ? "checkmark.square.fill" : "square")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(item.done ? "Fait : \(item.text)" : "À faire : \(item.text)")
            .help(item.done ? "Remettre à faire" : "Marquer comme fait")
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
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
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// Ce qui sort de Vigie le dit (« Ouvrir dans … ») ; ils passent à la ligne, le panneau est étroit.
    private var links: some View {
        WrapLayout(spacing: 14, lineSpacing: 8) {
            if let path = run.report?.report {
                Button("Ouvrir le rapport", systemImage: "doc.text") {
                    NSWorkspace.shared.open(URL(filePath: (run.folder as NSString).appendingPathComponent(path)))
                }
                .help("Ouvre le rapport détaillé dans son app")
            }
            ForEach(run.report?.links ?? []) { link in
                if let url = URL(string: link.url) {
                    Link(destination: url) { Label(link.label, systemImage: "arrow.up.right.square") }
                        .help("Ouvrir dans ton navigateur")
                }
            }
            AsyncButton(store.conversation(conversationID)?.openLabel ?? "Ouvrir dans VS Code",
                        systemImage: "bubble.left.and.text.bubble.right") {
                await store.openConversationInVSCode(conversationID, cwd: run.folder)
            }
            .help("La conversation de l'agent")
            Button("Ouvrir dans le Finder", systemImage: "folder") {
                NSWorkspace.shared.open(URL(filePath: run.folder, directoryHint: .isDirectory))
            }
            .help("Le dossier du projet")
        }
        .buttonStyle(.link)
    }

    /// « Retirer » ne retire que de Vigie : le fichier du rapport reste dans le dossier du projet.
    private var remove: some View {
        AsyncButton("Retirer ce rapport", systemImage: "xmark") { await store.hideAgentRun(run, in: conversationID) }
            .buttonStyle(.link)
            .help("Retire ce rapport de la page de la conversation ; son fichier reste dans le dossier du projet")
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
