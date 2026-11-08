import SwiftUI

/// Historique : toutes les demandes d'autorisation et leur issue (acceptée, refusée, refusée d'office, en échec…), avec
/// des filtres ; les mots, icônes et couleurs viennent de `HistoryStatus`. Un clic sur une ligne ouvre son détail à droite : pourquoi, la commande entière, de quoi la relancer.
/// Filtres et lignes à la marge des pages (28 pt, à gauche et à droite pour les filtres) ; la table défile seule,
/// jusqu'au bord droit du détail, hors de `Page`.
struct HistoryView: View {
    @Environment(VigieStore.self) private var store
    @State private var selection: HistoryItem.ID?

    private static let windows: [(Int, String)] = [(60, "1 h"), (1440, "24 h"), (10080, "7 jours")]

    var body: some View {
        @Bindable var store = store
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 12) {
                filters
                statusChips
            }
            // symétriques : le champ « Chercher » s'arrête à la marge des pages, comme les filtres commencent
            .padding(.horizontal, PageMetrics.margin)
            // La table touche le bord droit de la fenêtre (sa barre de défilement y reste collée) ; à gauche, ses
            // lignes tombent sur la marge des pages, comme les filtres. Jamais collée à gauche : elle passerait sous la
            // barre latérale et répartirait ses colonnes sur une largeur fausse (« Résultat » coupé).
            table
                .padding(.leading, PageMetrics.margin - PageMetrics.tableRowInset)
        }
        .padding(.top, PageMetrics.verticalMargin)
        .splitColumn(minWidth: 340)
        .navigationTitle("Historique")
        .navigationSubtitle(subtitle)
        .inspector(isPresented: Binding(get: { selected != nil }, set: { if !$0 { selection = nil } })) {
            if let selected {
                HistoryDetail(item: selected)
                    .splitColumn()
                    .inspectorColumnWidth(min: 300, ideal: 360, max: 480)
            }
        }
        // relu toutes les 15 s fenêtre à l'écran, et tout de suite quand un filtre change ou qu'elle revient
        .task(id: "\(filterKey)|\(store.windowVisible)") {
            while !Task.isCancelled && store.windowVisible {
                await store.refreshHistory()
                try? await Task.sleep(for: .seconds(15), tolerance: .seconds(3))
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
        item.conversationId.flatMap { store.conversation($0)?.shortTitle }
            ?? item.project.map { ProjectName.display($0, cwd: item.cwd) }
            ?? item.conversationTitle ?? "Conversation"
    }

    /// Les filtres par issue : une puce par issue présente, la choisie pleine (bleu d'action).
    private var statusChips: some View {
        let counts = store.historyPage?.counts ?? [:]
        let total = counts.values.reduce(0, +)
        return FlowLayout(spacing: 6) {
            filterChip("Tout \(Fmt.int(total))", symbol: nil, selected: store.historyStatus == nil) {
                store.historyStatus = nil
            }
            ForEach(HistoryStatus.allCases) { status in
                let count = counts[status.rawValue] ?? 0
                if count > 0 || store.historyStatus == status.rawValue {
                    filterChip("\(status.title) \(Fmt.int(count))", symbol: status.symbol,
                               selected: store.historyStatus == status.rawValue) {
                        store.historyStatus = store.historyStatus == status.rawValue ? nil : status.rawValue
                    }
                }
            }
        }
    }

    /// Une puce de filtre : la `Chip` standard (sans chevron : elle filtre, elle n'ouvre rien), choisie = pleine.
    private func filterChip(_ title: String, symbol: String?, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Chip(title, symbol: symbol, tone: selected ? .selected : .neutral, size: .regular)
        }
        .buttonStyle(ChipButtonStyle())
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    @ViewBuilder
    private var table: some View {
        if store.historyPage == nil {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if items.isEmpty {
            ContentUnavailableView("Rien sur cette période", systemImage: "clock",
                                   description: Text("Change de période ou de filtre."))
        } else {
            // largeurs idéales qui tiennent dans la fenêtre par défaut (rien ne dépasse, pas de défilement de côté) ;
            // « Pourquoi » prend la place qui reste et se coupe en fin, entière au survol et dans le détail
            Table(items, selection: $selection) {
                TableColumn("Heure") { item in
                    Text(item.ts.map { Fmt.when($0, now: store.now) } ?? Fmt.none)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .help(item.ts.map(HistoryDetail.exact) ?? "")
                }
                .width(min: 64, ideal: 84, max: 120)
                TableColumn("Résultat") { item in
                    Label(item.historyStatus.label, systemImage: item.historyStatus.symbol)
                        .foregroundStyle(item.historyStatus.color)
                        .labelStyle(.titleAndIcon)
                }
                .width(min: 100, ideal: 150, max: 180)
                TableColumn("Action") { item in
                    VStack(alignment: .leading, spacing: 1) {
                        Text(item.title ?? item.tool ?? "Action").lineLimit(1)
                        if let command = item.command, !command.isEmpty, command != item.title {
                            CodeLine(command)
                        }
                    }
                }
                .width(min: 160, ideal: 280)
                TableColumn("Conversation") { item in
                    HStack(spacing: 6) {
                        Text(conversationName(item)).lineLimit(1)
                        if item.isCodex {
                            Chip("Codex")
                        }
                    }
                }
                .width(min: 90, ideal: 130)
                TableColumn("Pourquoi") { item in
                    Text(item.reason ?? "")
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .truncationMode(.tail)
                        .help(item.reason ?? "")
                }
                .width(min: 120, ideal: 180)
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

    /// La date exacte, avec les secondes (au survol) : « lundi 26 octobre 20:14:05 ».
    nonisolated static func exact(_ date: Date) -> String {
        date.formatted(.dateTime.weekday(.wide).day().month(.wide).hour().minute().second().locale(Fmt.locale))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Chip(item.historyStatus.label, symbol: item.historyStatus.symbol, tone: item.historyStatus.tone)
                ObjectHeader(item.title ?? item.tool ?? "Action")
                if let reason = item.reason {
                    Text(reason).fixedSize(horizontal: false, vertical: true)
                }
                LabeledContent("Quand") {
                    Text(item.ts.map { Fmt.when($0, now: store.now) } ?? Fmt.none)
                        .help(item.ts.map(Self.exact) ?? "")
                }
                LabeledContent("Conversation") {
                    HStack(spacing: 6) {
                        Text(item.conversationId.flatMap { store.conversation($0)?.shortTitle }
                             ?? item.project.map { ProjectName.display($0, cwd: item.cwd) }
                             ?? item.conversationTitle ?? Fmt.none)
                        if item.isCodex { Text("Codex").foregroundStyle(.secondary) }
                    }
                }
                if let agent = item.agent { LabeledContent("Agent", value: agent) }
                if let rule = item.rule { LabeledContent("Garde-fou", value: rule) }
                if let command = item.command, !command.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        CardTitle("Commande")
                        Text(command)
                            .font(.callout.monospaced())
                            .textSelection(.enabled)
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.quinary, in: .rect(cornerRadius: Theme.cornerInner))
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
                        SystemActions.copy("Relance cette action exactement à l'identique : je l'autoriserai.\n\n```\n\(command)\n```")
                        copied = "relaunch"
                    }
                    .glassButton()
                    .help("À coller dans sa conversation : elle relance la commande, tu l'autorises dans Vigie ou dans la conversation")
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
                AsyncButton(item.conversationId.flatMap { store.conversation($0)?.openLabel } ?? "Ouvrir dans VS Code", systemImage: "arrow.up.forward.app") {
                    await store.openConversationInVSCode(item.conversationId, cwd: item.cwd)
                }
                .glassButton(.primary)
            }
        }
        .padding(.top, 4)
    }
}
