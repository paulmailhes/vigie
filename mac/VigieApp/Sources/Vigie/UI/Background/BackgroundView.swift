import AppKit
import SwiftUI

/// Outil « En fond » : ce que tes conversations ont laissé tourner (Chrome sans fenêtre, serveurs, rendus, apps),
/// en trois groupes, du geste à faire à ce qui est normal : les oubliés (conversation fermée), les apps ouvertes par
/// un agent, puis ce qui accompagne une conversation ouverte. Un clic sur une ligne montre la commande entière,
/// le dossier et la conversation. Le titre est dans la barre de la fenêtre, avec l'état chiffré en sous-titre.
struct BackgroundView: View {
    @Environment(VigieStore.self) private var store
    @State private var expanded: String?
    @State private var confirmBusy: [BackgroundGroup] = []
    @State private var confirmApp: BackgroundGroup?
    @State private var confirmAll = false

    var body: some View {
        Page {
            if let problem = store.backgroundProblem, store.background == nil {
                // le texte du moteur dit ce qui ne va pas
                ContentUnavailableView("Liste indisponible", systemImage: "memorychip", description: Text(problem))
            } else if let list = store.background {
                if list.groups.isEmpty {
                    ContentUnavailableView {
                        Label("Rien ne tourne en fond", systemImage: "checkmark.circle")
                    } description: {
                        Text("Tes conversations n'ont rien laissé : ni Chrome sans fenêtre, ni serveur, ni rendu.")
                    }
                    .padding(.top, 40)
                } else {
                    header(list)
                    sections(list.groups)
                }
                footer(list)
            } else {
                ProgressView("Lecture en cours…")
                    .frame(maxWidth: .infinity)
                    .padding(.top, 60)
            }
        }
        .navigationTitle("En fond")
        .navigationSubtitle(subtitle)
        .task { await store.followBackground() }
        .confirmationDialog("Sa conversation travaille encore", isPresented: Binding(
            get: { !confirmBusy.isEmpty }, set: { if !$0 { confirmBusy = [] } }
        ), titleVisibility: .visible) {
            Button("Arrêter quand même", role: .destructive) {
                let groups = confirmBusy
                Task { await store.stopBackground(groups, confirm: true) }
            }
            Button("Annuler", role: .cancel) {}
        } message: {
            Text("L'arrêter peut casser ce qu'elle est en train de faire.")
        }
        .confirmationDialog(Text("Quitter \(confirmApp?.label ?? "l'app") ?"), isPresented: Binding(
            get: { confirmApp != nil }, set: { if !$0 { confirmApp = nil } }
        ), titleVisibility: .visible) {
            Button("Quitter") { if let app = confirmApp { store.quitBackgroundApp(app) } }
            Button("Annuler", role: .cancel) {}
        } message: {
            Text("Comme avec ⌘Q : l'app peut te demander d'enregistrer. Un agent l'avait ouverte ; tu peux aussi la garder.")
        }
        .confirmationDialog(Text(allTitle), isPresented: $confirmAll, titleVisibility: .visible) {
            Button("Arrêter") { Task { await store.stopBackground(forgotten) } }
            Button("Annuler", role: .cancel) {}
        } message: {
            Text("Leurs conversations sont fermées : plus personne ne s'en sert.")
        }
    }

    // MARK: Sous-titre, chiffre clé et groupes

    /// « 16 Go sur 36 Go · 5 groupes · mis à jour à l'instant » : un état chiffré, 3 infos au plus.
    private var subtitle: String {
        guard let list = store.background else { return "" }
        let groups = list.total?.groups ?? list.groups.count
        return InfoLine.text([
            groups > 0 ? memoryLine(list) : nil,
            groups > 0 ? Fmt.count(groups, "groupe") : "Rien ne tourne",
            list.scannedAt.map { "mis à jour \(Fmt.ago($0, now: store.now))" },
        ])
    }

    /// « 16 Go sur 36 Go » (la mémoire de ton Mac).
    private func memoryLine(_ list: BackgroundList) -> String {
        let used = Fmt.memory(mb: list.total?.memoryMb)
        return ram.map { "\(used) sur \($0) Go" } ?? used
    }

    /// La mémoire du Mac, en Go entiers.
    private var ram: Int? {
        let bytes = ProcessInfo.processInfo.physicalMemory
        return bytes > 0 ? Int((Double(bytes) / 1_073_741_824).rounded()) : nil
    }

    /// Le chiffre clé de la page, en grand : la mémoire prise par ce qui tourne en fond.
    @ViewBuilder
    private func header(_ list: BackgroundList) -> some View {
        if let total = list.total, (total.groups ?? 0) > 0 {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(Fmt.memory(mb: total.memoryMb))
                    .font(.title2.bold())
                    .monospacedDigit()
                Text(InfoLine.text([ram.map { "de mémoire, sur \($0) Go" } ?? "de mémoire",
                                    total.processes.map { Fmt.count($0, "processus", "processus") }]))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 6)
            .accessibilityElement(children: .combine)
        }
    }

    private var forgotten: [BackgroundGroup] {
        store.background?.groups.filter { $0.groupState == .forgotten } ?? []
    }

    private var allTitle: String {
        let mb = forgotten.reduce(0) { $0 + ($1.memoryMb ?? 0) }
        return "Arrêter \(Fmt.count(forgotten.count, "oublié")) (\(Fmt.memory(mb: mb))) ?"
    }

    @ViewBuilder
    private func sections(_ groups: [BackgroundGroup]) -> some View {
        let lost = groups.filter { $0.groupState == .forgotten }
        let apps = groups.filter { $0.groupState == .app }
        let open = groups.filter { $0.groupState != .forgotten && $0.groupState != .app }
        if !lost.isEmpty {
            CardSection("Oubliés", count: lost.count, note: "Leur conversation est fermée.") {
                rows(lost)
            } trailing: {
                if lost.count > 1 {
                    Button("Arrêter les \(lost.count) oubliés") { confirmAll = true }
                        .glassButton(.primary)
                }
            }
        }
        if !apps.isEmpty {
            CardSection("Apps ouvertes par un agent", count: apps.count, note: "Tu t'en sers peut-être encore.") {
                rows(apps)
            }
        }
        if !open.isEmpty {
            CardSection("Avec une conversation ouverte", count: open.count) {
                rows(open)
            }
        }
    }

    private func rows(_ groups: [BackgroundGroup]) -> some View {
        ForEach(groups) { group in
            BackgroundRow(group: group, expanded: expanded == group.id) {
                withAnimation(.smooth(duration: 0.2)) { expanded = expanded == group.id ? nil : group.id }
            } stop: {
                if group.groupState == .app {
                    confirmApp = group
                } else if group.groupState.conversationBusy {
                    confirmBusy = [group]
                } else {
                    Task {
                        let ask = await store.stopBackground([group])
                        if !ask.isEmpty { confirmBusy = ask }
                    }
                }
            }
        }
    }

    private func footer(_ list: BackgroundList) -> some View {
        @Bindable var store = store
        return VStack(alignment: .leading, spacing: 10) {
            Toggle(isOn: $store.stopForgotten) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Vigie arrête les Chrome sans fenêtre oubliés")
                    Text("Quand leur conversation est fermée depuis 6 h et qu'ils ne consomment plus rien. Rien d'autre ne s'arrête tout seul.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .toggleStyle(.switch)
            if let last = list.autoStopped.first {
                Text("Dernier arrêt automatique : \(last.label ?? "Chrome sans fenêtre")\(last.project.map { " (\(ProjectName.display($0)))" } ?? "") · \(Fmt.memory(mb: last.memoryMb)) libérés · \(Fmt.ago(last.ts, now: store.now))")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Text("Seuls les processus lancés par tes conversations apparaissent ici. Un programme que tu lances toi-même n'y est jamais, et Vigie, VS Code, Claude et les MCP ne sont jamais listés.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 6)
    }
}

/// Une ligne : pastille d'état, ce que c'est, sa conversation (nommée comme partout : « Atelier »), depuis quand, sa
/// mémoire, le bouton. Fenêtre étroite : la conversation passe sous ce que c'est.
struct BackgroundRow: View {
    @Environment(VigieStore.self) private var store
    let group: BackgroundGroup
    let expanded: Bool
    let toggle: () -> Void
    let stop: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 10) {
                    dot
                    what
                        .frame(minWidth: 120, idealWidth: 180, maxWidth: .infinity, alignment: .leading)
                    conversation
                        .frame(width: 240, alignment: .leading)
                    numbers
                    stopButton
                }
                HStack(alignment: .center, spacing: 10) {
                    dot
                    VStack(alignment: .leading, spacing: 6) {
                        what
                        conversation
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    numbers
                    stopButton
                }
            }
            .contentShape(.rect)
            .onTapGesture(perform: toggle)
            if expanded { details }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(InfoLine.text([group.label ?? "Commande", "lancé par \(conversationName)", stateText, Fmt.memory(mb: group.memoryMb)]))
        .accessibilityHint(expanded ? "Referme le détail" : "Montre la commande entière et le dossier")
        // le clic sur la ligne n'est qu'un geste : VoiceOver a son action
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: expanded ? "Replier" : "Déplier", toggle)
    }

    private var dot: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .accessibilityHidden(true)
    }

    /// Ce que c'est : « Chrome sans fenêtre », et son détail.
    private var what: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(group.label ?? "Commande")
                .textRole(.item)
                .lineLimit(1)
            if let detail = group.detail {
                Text(detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .help(detail)
            }
        }
    }

    /// La conversation qui l'a lancé : son nom court, puis son état et son titre de VS Code.
    private var conversation: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(conversationName)
                .lineLimit(1)
            InfoLine(parts: [stateText, group.conversationTitle])
        }
    }

    /// « depuis 1 j » et la mémoire, en colonnes alignées d'une ligne à l'autre.
    private var numbers: some View {
        HStack(spacing: 10) {
            Text(launched)
                .foregroundStyle(.secondary)
                .frame(width: 76, alignment: .trailing)
                .help(group.startedAt.map { "Lancé \(Fmt.when($0, now: store.now))" } ?? "")
            Text(Fmt.memory(mb: group.memoryMb))
                .frame(width: 64, alignment: .trailing)
                .help(group.memoryReal == true ? "Mémoire réelle" : "Mémoire estimée")
        }
        .font(.callout)
        .monospacedDigit()
        .lineLimit(1)
    }

    private var stopButton: some View {
        Button(group.groupState == .app ? "Quitter" : "Arrêter", action: stop)
            .glassButton()
            .frame(width: 80, alignment: .trailing)
    }

    /// « depuis 1 j », « à l'instant » juste après le lancement.
    private var launched: String {
        guard let started = group.startedAt else { return Fmt.none }
        return store.now.timeIntervalSince(started) < 5 ? "à l'instant" : "depuis \(Fmt.age(since: started, now: store.now))"
    }

    private var color: Color {
        switch group.groupState {
        case .forgotten: Theme.warn
        case .working, .waiting: Theme.live
        case .app, .idle, .unknown: Color.secondary.opacity(0.6)
        }
    }

    /// Le nom de la conversation, comme dans le reste de l'app ; fermée depuis plus de 48 h, Vigie ne la suit plus :
    /// le nom de son projet.
    private var conversationName: String {
        if let id = group.conversationId, let conversation = store.conversation(id) { return conversation.shortTitle }
        if let project = group.project { return ProjectName.display(project, cwd: group.cwd) }
        return "Conversation inconnue"
    }

    /// L'état de la conversation : « Travaille », « Fermée il y a 2 h ».
    private var stateText: String {
        switch group.groupState {
        case .forgotten: "Fermée\(group.forgottenSince.map { " \(Fmt.ago($0, now: store.now))" } ?? "")"
        case .working: "Travaille"
        case .waiting: "T'attend"
        case .idle: "Au repos"
        case .app: conversationOpen ? "Ouverte" : "Fermée"
        case .unknown: ""
        }
    }

    private var conversationOpen: Bool {
        group.conversationId.flatMap { store.conversation($0) }?.isOpen == true
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let command = group.command {
                Text(command)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 14) {
                if let processes = group.processes {
                    Text(Fmt.count(processes, "processus", "processus"))
                }
                if !group.ports.isEmpty {
                    Text("port \(group.ports.map(String.init).joined(separator: ", "))")
                }
                if let cpu = group.cpu {
                    Text("processeur \(Int(cpu)) %")
                }
                if let since = group.forgottenSince {
                    Text("oublié \(Fmt.ago(since, now: store.now))")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            WrapLayout(spacing: 8) {
                if let id = group.conversationId {
                    if store.conversation(id) != nil {
                        Button("Voir la conversation") { store.route = .conversation(id) }
                            .glassButton()
                    } else {
                        // fermée depuis plus de 48 h : Vigie ne la suit plus, VS Code la rouvre
                        AsyncButton("Ouvrir dans VS Code") { await store.openConversationInVSCode(id, cwd: group.cwd) }
                            .glassButton()
                            .help("Rouvre sa conversation dans VS Code")
                    }
                }
                if let cwd = group.cwd {
                    Button("Ouvrir dans le Finder") {
                        NSWorkspace.shared.activateFileViewerSelecting([URL(filePath: cwd)])
                    }
                    .glassButton()
                    .help("Le dossier où il a été lancé")
                }
                if let port = group.ports.first {
                    // String(port) : un Int dans un libellé serait groupé (« 5 173 »)
                    Button("Ouvrir localhost:\(String(port))") {
                        if let url = URL(string: "http://localhost:\(port)") { NSWorkspace.shared.open(url) }
                    }
                    .glassButton()
                    .help("Dans ton navigateur")
                }
            }
            .controlSize(.small)
        }
        .padding(.leading, 18)
    }
}
