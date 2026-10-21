import SwiftUI

/// Historique : toutes les demandes d'autorisation et leur issue (acceptée, refusée, bloquée, échouée…), avec des
/// filtres. Un clic sur une ligne ouvre son détail à droite : pourquoi, la commande entière, de quoi la relancer.
struct HistoryView: View {
    @Environment(VigieStore.self) private var store
    @State private var selection: HistoryItem.ID?

    private static let windows: [(Int, String)] = [(60, "1 h"), (1440, "24 h"), (10080, "7 jours")]

    var body: some View {
        @Bindable var store = store
        VStack(alignment: .leading, spacing: 12) {
            filters
            statusChips
            table
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .navigationTitle("Historique")
        .navigationSubtitle(subtitle)
        .inspector(isPresented: Binding(get: { selected != nil }, set: { if !$0 { selection = nil } })) {
            if let selected {
                HistoryDetail(item: selected)
                    .inspectorColumnWidth(min: 300, ideal: 360, max: 480)
            }
        }
        // relu toutes les 5 s, et tout de suite quand un filtre change
        .task(id: filterKey) {
            while !Task.isCancelled {
                await store.refreshHistory()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    private var items: [HistoryItem] { store.historyPage?.items ?? [] }
    private var selected: HistoryItem? { selection.flatMap { id in items.first { $0.id == id } } }
    private var filterKey: String {
        "\(store.historyWindow)|\(store.historyStatus ?? "")|\(store.historyConversation ?? "")|\(store.historyQuery)"
    }

    private var subtitle: String {
        let total = store.historyPage?.counts?.values.reduce(0, +) ?? 0
        let span = Self.windows.first { $0.0 == store.historyWindow }?.1 ?? ""
        return "\(Fmt.count(total, "demande", "demandes")) sur \(span)"
    }

    private var filters: some View {
        @Bindable var store = store
        return HStack(spacing: 12) {
            Picker("Période", selection: $store.historyWindow) {
                ForEach(Self.windows, id: \.0) { Text($0.1).tag($0.0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            Menu {
                Button("Toutes les conversations") { store.historyConversation = nil }
                Divider()
                ForEach(conversations, id: \.id) { conversation in
                    Button(conversation.name) { store.historyConversation = conversation.id }
                }
            } label: {
                Label(conversationLabel, systemImage: "bubble.left.and.bubble.right")
            }
            .fixedSize()
            Spacer()
            TextField("Chercher (commande, projet, raison…)", text: $store.historyQuery)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 280)
        }
        .controlSize(.regular)
    }

    /// Les conversations présentes sur la période (plus celle filtrée, même si elle n'a plus rien).
    private var conversations: [(id: String, name: String)] {
        var seen = Set<String>()
        var out: [(id: String, name: String)] = []
        for item in items {
            guard let id = item.conversationId, !seen.contains(id) else { continue }
            seen.insert(id)
            out.append((id, conversationName(item)))
        }
        return out.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }

    private var conversationLabel: String {
        guard let id = store.historyConversation else { return "Toutes les conversations" }
        return store.conversation(id)?.shortTitle ?? items.first { $0.conversationId == id }.map(conversationName) ?? "Une conversation"
    }

    private func conversationName(_ item: HistoryItem) -> String {
        item.conversationId.flatMap { store.conversation($0)?.shortTitle } ?? item.project ?? item.conversationTitle ?? "Conversation"
    }

    private var statusChips: some View {
        let counts = store.historyPage?.counts ?? [:]
        let total = counts.values.reduce(0, +)
        return FlowLayout(spacing: 6) {
            chip(title: "Tout", count: total, symbol: nil, color: .accentColor, selected: store.historyStatus == nil) {
                store.historyStatus = nil
            }
            ForEach(HistoryStatus.allCases) { status in
                let count = counts[status.rawValue] ?? 0
                if count > 0 || store.historyStatus == status.rawValue {
                    chip(title: status.title, count: count, symbol: status.symbol, color: status.color,
                         selected: store.historyStatus == status.rawValue) {
                        store.historyStatus = store.historyStatus == status.rawValue ? nil : status.rawValue
                    }
                }
            }
        }
    }

    private func chip(title: String, count: Int, symbol: String?, color: Color, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let symbol { Image(systemName: symbol).foregroundStyle(selected ? .white : color) }
                Text(title)
                Text(Fmt.int(count)).monospacedDigit().foregroundStyle(selected ? .white.opacity(0.8) : .secondary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .foregroundStyle(selected ? .white : .primary)
            .background(selected ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.quinary), in: .capsule)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var table: some View {
        if store.historyPage == nil {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if items.isEmpty {
            ContentUnavailableView("Rien sur cette période", systemImage: "clock",
                                   description: Text("Change de période ou de filtre."))
        } else {
            Table(items, selection: $selection) {
                TableColumn("Heure") { item in
                    Text(item.ts.map { Fmt.when($0, now: store.now) } ?? "")
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                .width(min: 70, ideal: 90, max: 130)
                TableColumn("Issue") { item in
                    Label(item.historyStatus.label, systemImage: item.historyStatus.symbol)
                        .foregroundStyle(item.historyStatus.color)
                        .labelStyle(.titleAndIcon)
                }
                .width(min: 90, ideal: 110, max: 130)
                TableColumn("Action") { item in
                    VStack(alignment: .leading, spacing: 1) {
                        Text(item.title ?? item.tool ?? "Action").lineLimit(1)
                        if let command = item.command, !command.isEmpty, command != item.title {
                            Text(command)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                }
                .width(min: 200, ideal: 340)
                TableColumn("Conversation") { item in
                    HStack(spacing: 6) {
                        Text(conversationName(item)).lineLimit(1)
                        if item.isCodex {
                            Text("Codex")
                                .font(.caption)
                                .padding(.horizontal, 5)
                                .background(.quaternary, in: .capsule)
                        }
                    }
                }
                .width(min: 120, ideal: 180)
                TableColumn("Pourquoi") { item in
                    Text(item.reason ?? "")
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                .width(min: 160, ideal: 280)
            }
            .tableStyle(.inset)
        }
    }
}

/// Le détail d'une ligne : ce qui s'est passé, la commande entière, et de quoi la débloquer.
struct HistoryDetail: View {
    @Environment(VigieStore.self) private var store
    let item: HistoryItem
    @State private var copied: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Label(item.historyStatus.label, systemImage: item.historyStatus.symbol)
                    .font(.headline)
                    .foregroundStyle(item.historyStatus.color)
                Text(item.title ?? item.tool ?? "Action")
                    .font(.title3.bold())
                    .fixedSize(horizontal: false, vertical: true)
                if let reason = item.reason {
                    Text(reason).fixedSize(horizontal: false, vertical: true)
                }
                LabeledContent("Quand", value: item.ts.map { $0.formatted(date: .abbreviated, time: .standard) } ?? "—")
                LabeledContent("Conversation") {
                    HStack(spacing: 6) {
                        Text(item.conversationId.flatMap { store.conversation($0)?.shortTitle } ?? item.project ?? item.conversationTitle ?? "—")
                        if item.isCodex { Text("Codex").foregroundStyle(.secondary) }
                    }
                }
                if let agent = item.agent { LabeledContent("Agent", value: agent) }
                if let rule = item.rule { LabeledContent("Garde-fou", value: rule) }
                if let command = item.command, !command.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Commande").font(.headline)
                        Text(command)
                            .font(.callout.monospaced())
                            .textSelection(.enabled)
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.quinary, in: .rect(cornerRadius: 8))
                    }
                }
                actions
            }
            .padding(16)
        }
    }

    @ViewBuilder
    private var actions: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let id = item.conversationId, store.conversation(id) != nil {
                Button("Voir la conversation", systemImage: "arrow.right.circle") { store.route = .conversation(id) }
                    .glassButton()
            }
            if let command = item.command, !command.isEmpty {
                Button(copied == "command" ? "Copiée" : "Copier la commande", systemImage: copied == "command" ? "checkmark" : "doc.on.doc") {
                    SystemActions.copy(command)
                    copied = "command"
                }
                .glassButton()
                if item.didNotRun {
                    // Débloquer : Claude la relance à l'identique ; Vigie la redemande alors (fenêtre + Vigie).
                    Button(copied == "relaunch" ? "Message copié" : "Copier un message de relance",
                           systemImage: copied == "relaunch" ? "checkmark" : "arrow.clockwise") {
                        SystemActions.copy("Je t'autorise cette action : relance-la exactement à l'identique, je la validerai.\n\n```\n\(command)\n```")
                        copied = "relaunch"
                    }
                    .glassButton()
                    .help("À coller dans sa conversation : elle relance la commande, tu la valides dans Vigie ou dans la conversation")
                    if item.needsPassword == true {
                        AsyncButton("Lancer dans Terminal", systemImage: "terminal") {
                            await store.runInTerminal(command, cwd: item.cwd)
                        }
                        .glassButton()
                        .help("Prépare la commande dans Terminal : tu appuies sur Entrée et tapes ton mot de passe")
                    }
                }
            }
            if item.conversationId != nil {
                AsyncButton(item.conversationId.flatMap { store.conversation($0)?.openLabel } ?? "Ouvrir la conversation", systemImage: "arrow.up.forward.app") {
                    await store.openConversationInVSCode(item.conversationId, cwd: item.cwd)
                }
                .glassButton(.primary)
            }
        }
        .padding(.top, 4)
    }
}
