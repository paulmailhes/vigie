import SwiftUI

/// Vue d'ensemble : ce qui t'attend (s'il y a quelque chose), en ce moment (comptes), conversations.
/// Le reste (depuis ton passage, graphique, acceptations) est replié en bas.
struct OverviewView: View {
    @Environment(VigieStore.self) private var store
    @State private var showAllReports = false
    @AppStorage("overview.more") private var showMore = false
    @State private var showAllLater = false

    private static let reportsShown = 3

    var body: some View {
        Group {
            if store.loadedOnce {
                content
            } else {
                LoadingView()
            }
        }
        .navigationTitle("Vue d'ensemble")
        .navigationSubtitle(subtitle)
    }

    private var content: some View {
        Page {
            if let notices = store.engineInfo?.notices, !notices.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(notices.enumerated()), id: \.offset) { _, notice in
                        Label(notice.text, systemImage: "info.circle")
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 6)
            }

            if !urgent.isEmpty {
                urgentSection
            }

            LiveSection()

            ConversationListSection()

            if !later.isEmpty {
                laterSection
            }

            DisclosureGroup(isExpanded: $showMore) {
                VStack(alignment: .leading, spacing: 22) {
                    CardSection(sinceHeader) {
                        SinceRow()
                    }
                    if !store.reports.isEmpty {
                        reportsSection
                    }
                    UsageSection()
                    AcceptedFeedSection()
                }
                .padding(.top, 12)
            } label: {
                Text("Historique et consommation")
                    .font(.headline)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 6)
        }
        .task { await store.followCardDetails() }
    }

    /// Ce qui attend ta décision maintenant (rouge) : toujours en haut, en entier.
    private var urgent: [ReviewItem] {
        store.toReview.filter { $0.needsDecision || $0.reviewKind == .waiting }
    }

    /// Le reste (questions choisies pour toi, actions laissées de côté, limites) : à relire, sans urgence.
    private var later: [ReviewItem] {
        store.toReview.filter { !($0.needsDecision || $0.reviewKind == .waiting) }
    }

    private var urgentSection: some View {
        CardSection {
            ForEach(urgent) { item in
                ReviewRow(item: item)
            }
        } header: {
            HStack(spacing: 6) {
                Text("À décider")
                CountBadge(count: urgent.count, urgent: true)
            }
        }
    }

    private var laterSection: some View {
        CardSection {
            ForEach(showAllLater ? later : Array(later.prefix(Self.reportsShown))) { item in
                ReviewRow(item: item)
            }
            if !showAllLater && later.count > Self.reportsShown {
                ShowAllButton(count: later.count) { showAllLater = true }
            }
        } header: {
            HStack(spacing: 6) {
                Text("À relire")
                Text(Fmt.int(later.count))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        }
    }

    private var reportsSection: some View {
        CardSection("Rapports et fins de mission") {
            ForEach(showAllReports ? store.reports : Array(store.reports.prefix(Self.reportsShown))) { row in
                ReportRow(report: row.value)
            }
            if !showAllReports && store.reports.count > Self.reportsShown {
                ShowAllButton(count: store.reports.count) { showAllReports = true }
            }
        }
    }

    private var sinceHeader: String {
        guard let since = store.since else { return "Depuis ton dernier passage" }
        return "Depuis ton dernier passage, \(Fmt.when(since, now: store.now))"
    }

    private var subtitle: String {
        let open = store.conversations.filter(\.isOpen)
        let working = open.count(where: { $0.state == .working })
        var parts = [Fmt.count(open.count, "conversation ouverte", "conversations ouvertes")]
        if working > 0 { parts.append("\(working) au travail") }
        return parts.joined(separator: " · ")
    }
}

/// « Depuis ton dernier passage » : une ligne de chiffres et « J'ai tout vu ».
struct SinceRow: View {
    @Environment(VigieStore.self) private var store

    var body: some View {
        let summary = store.sinceSummary
        HStack(alignment: .center, spacing: 16) {
            FlowStats(items: items(summary))
            Spacer(minLength: 8)
            Button("J'ai tout vu", systemImage: "checkmark") {
                Task { await store.markSeen() }
            }
            .glassButton()
            .help("Remet les compteurs à zéro")
        }
        .padding(.vertical, 4)
    }

    private func items(_ summary: SinceSummary?) -> [FlowStats.Item] {
        let accepted = summary?.accepted ?? 0
        let questions = summary?.questionsAuto ?? 0
        let blocked = summary?.blocked ?? 0
        let reports = summary?.reports ?? 0
        let failed = summary?.testsFailed ?? 0
        let limits = summary?.limits ?? 0
        var list: [FlowStats.Item] = [.init(value: accepted, label: accepted > 1 ? "acceptées" : "acceptée")]
        if questions > 0 { list.append(.init(value: questions, label: questions > 1 ? "questions choisies" : "question choisie")) }
        if blocked > 0 { list.append(.init(value: blocked, label: blocked > 1 ? "bloquées" : "bloquée", alert: true)) }
        if reports > 0 { list.append(.init(value: reports, label: reports > 1 ? "rapports" : "rapport")) }
        if failed > 0 { list.append(.init(value: failed, label: failed > 1 ? "tests en échec" : "test en échec")) }
        if limits > 0 { list.append(.init(value: limits, label: limits > 1 ? "limites atteintes" : "limite atteinte")) }
        return list
    }
}

/// Chiffres en gras suivis d'un mot, séparés par des points ; retour à la ligne si la place manque.
struct FlowStats: View {
    struct Item: Hashable {
        var value: Int
        var label: String
        var alert = false
    }

    let items: [Item]

    var body: some View {
        items.enumerated().reduce(Text("")) { text, entry in
            let (index, item) = entry
            let separator = index == 0 ? Text("") : Text("  ·  ").foregroundStyle(.tertiary)
            let number = Text(Fmt.int(item.value)).bold().monospacedDigit()
                .foregroundStyle(item.alert ? AnyShapeStyle(Color.red) : AnyShapeStyle(.primary))
            // Espaces insécables : un chiffre et son mot ne sont jamais coupés en fin de ligne.
            let word = Text("\u{00A0}" + item.label.replacingOccurrences(of: " ", with: "\u{00A0}"))
                .foregroundStyle(item.alert ? AnyShapeStyle(Color.red) : AnyShapeStyle(.secondary))
            return Text("\(text)\(separator)\(number)\(word)")
        }
        .font(.title3)
        .fixedSize(horizontal: false, vertical: true)
        .contentTransition(.numericText())
    }
}
