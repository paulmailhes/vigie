import AppKit
import SwiftUI

/// Outil « En fond » : ce que tes conversations ont laissé tourner (Chrome sans fenêtre, serveurs, rendus, apps),
/// en trois groupes, du geste à faire à ce qui est normal : les oubliés (conversation fermée), les apps ouvertes par
/// un agent, puis ce qui accompagne une conversation ouverte. Un clic sur une ligne montre la commande entière,
/// le dossier et la conversation.
struct BackgroundView: View {
    @Environment(VigieStore.self) private var store
    @State private var expanded: String?
    @State private var confirmBusy: [BackgroundGroup] = []
    @State private var confirmApp: BackgroundGroup?
    @State private var confirmAll = false

    var body: some View {
        Page {
            header
            if let problem = store.backgroundProblem, store.background == nil {
                ContentUnavailableView("Relevé indisponible", systemImage: "memorychip", description: Text(problem))
            } else if let list = store.background {
                if list.groups.isEmpty {
                    ContentUnavailableView {
                        Label("Rien ne tourne en fond", systemImage: "checkmark.circle")
                    } description: {
                        Text("Tes conversations n'ont rien laissé : ni Chrome sans fenêtre, ni serveur, ni rendu.")
                    }
                    .padding(.top, 40)
                } else {
                    sections(list.groups)
                }
                footer(list)
            } else {
                ProgressView("Relevé en cours…")
                    .frame(maxWidth: .infinity)
                    .padding(.top, 60)
            }
        }
        .navigationTitle("En fond")
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

    // MARK: En-tête et groupes

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("En fond")
                .font(.largeTitle.bold())
            if let list = store.background, let total = list.total, (total.groups ?? 0) > 0 {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(Fmt.memory(mb: total.memoryMb))
                        .font(.title2.bold())
                        .monospacedDigit()
                    Text(summaryLine(list))
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("Ce que tes conversations ont laissé tourner : Chrome sans fenêtre, serveurs, rendus, apps.")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func summaryLine(_ list: BackgroundList) -> String {
        var parts: [String] = []
        let ram = ProcessInfo.processInfo.physicalMemory
        if ram > 0 { parts.append("sur \(Int((Double(ram) / 1_073_741_824).rounded())) Go") }
        if let groups = list.total?.groups { parts.append(Fmt.count(groups, "groupe")) }
        if let processes = list.total?.processes { parts.append(Fmt.count(processes, "processus", "processus")) }
        if let at = list.scannedAt { parts.append("relevé \(Fmt.ago(at, now: store.now))") }
        return parts.joined(separator: " · ")
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
            group("Oubliés", note: "leur conversation est fermée", groups: lost) {
                if lost.count > 1 {
                    Button("Arrêter les \(lost.count) oubliés") { confirmAll = true }
                        .glassButton(.primary)
                } else {
                    EmptyView()
                }
            }
        }
        if !apps.isEmpty {
            group("Apps ouvertes par un agent", note: "tu peux les vouloir", groups: apps) { EmptyView() }
        }
        if !open.isEmpty {
            group("Conversations ouvertes", note: nil, groups: open) { EmptyView() }
        }
    }

    private func group<Trailing: View>(_ title: String, note: String?, groups: [BackgroundGroup],
                                       @ViewBuilder trailing: () -> Trailing) -> some View {
        CardSection {
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
        } header: {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                if let note {
                    Text("· \(note)")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                trailing()
            }
        }
    }

    private func footer(_ list: BackgroundList) -> some View {
        @Bindable var store = store
        return VStack(alignment: .leading, spacing: 10) {
            Toggle(isOn: $store.stopForgotten) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Arrêter seuls les Chrome sans fenêtre oubliés")
                    Text("Quand leur conversation est fermée depuis 6 h et qu'ils ne consomment plus rien. Rien d'autre ne s'arrête tout seul.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .toggleStyle(.switch)
            if let last = list.autoStopped.first {
                Text("Dernier arrêt automatique : \(last.label ?? "Chrome sans fenêtre")\(last.project.map { " (\($0))" } ?? "") · \(Fmt.memory(mb: last.memoryMb)) libérés · \(Fmt.ago(last.ts, now: store.now))")
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

/// Une ligne : pastille d'état, ce que c'est, sa conversation, depuis quand, sa mémoire, le bouton.
struct BackgroundRow: View {
    @Environment(VigieStore.self) private var store
    let group: BackgroundGroup
    let expanded: Bool
    let toggle: () -> Void
    let stop: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 10) {
                Circle()
                    .fill(color)
                    .frame(width: 8, height: 8)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(group.label ?? "Commande")
                        .fontWeight(.medium)
                    if let detail = group.detail {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Text(where_)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .frame(width: 200, alignment: .leading)
                Text(Fmt.age(since: group.startedAt, now: store.now))
                    .font(.callout)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .frame(width: 52, alignment: .trailing)
                Text(Fmt.memory(mb: group.memoryMb))
                    .font(.callout)
                    .monospacedDigit()
                    .frame(width: 64, alignment: .trailing)
                    .help(group.memoryReal == true ? "Mémoire réelle" : "Mémoire estimée")
                Button(group.groupState == .app ? "Quitter" : "Arrêter", action: stop)
                    .glassButton()
                    .frame(width: 80, alignment: .trailing)
            }
            .contentShape(.rect)
            .onTapGesture(perform: toggle)
            if expanded { details }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(group.label ?? "Commande"), \(where_), \(Fmt.memory(mb: group.memoryMb))")
    }

    private var color: Color {
        switch group.groupState {
        case .forgotten: Theme.warn
        case .working, .waiting: Theme.live
        case .app, .idle, .unknown: Color.secondary.opacity(0.6)
        }
    }

    private var where_: String {
        let name = group.project ?? group.conversationTitle ?? "Conversation inconnue"
        switch group.groupState {
        case .forgotten: return "\(name) · fermée"
        case .working: return "\(name) · travaille"
        case .waiting: return "\(name) · t'attend"
        case .idle: return "\(name) · au repos"
        case .app: return "\(name) · \(conversationOpen ? "ouverte" : "fermée")"
        case .unknown: return name
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
            HStack(spacing: 8) {
                if let id = group.conversationId, store.conversation(id) != nil {
                    Button("Voir la conversation") { store.route = .conversation(id) }
                        .glassButton()
                }
                if let cwd = group.cwd {
                    Button("Afficher le dossier") {
                        NSWorkspace.shared.activateFileViewerSelecting([URL(filePath: cwd)])
                    }
                    .glassButton()
                }
                if let port = group.ports.first {
                    Button("Ouvrir localhost:\(port)") {
                        if let url = URL(string: "http://localhost:\(port)") { NSWorkspace.shared.open(url) }
                    }
                    .glassButton()
                }
            }
            .controlSize(.small)
        }
        .padding(.leading, 18)
    }
}
