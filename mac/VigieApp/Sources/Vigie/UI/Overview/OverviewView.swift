import SwiftUI

/// Vue d'ensemble : ce qui t'attend (s'il y a quelque chose), en ce moment (comptes), conversations.
/// Le reste (depuis ton passage, graphique, acceptations) est replié en bas.
struct OverviewView: View {
    @Environment(VigieStore.self) private var store
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
            UpdateBanner()

            if let notices = store.engineInfo?.notices, !notices.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(notices.enumerated()), id: \.offset) { _, notice in
                        Label(notice.text, systemImage: "info.circle")
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 6)
            }

            // Ordre d'importance : ce qui t'attend ou a mal tourné remonte ; la consommation passe devant les
            // acceptations quand un compte approche de sa limite.
            CardSection(sinceHeader) {
                SinceRow()
            }

            if !urgent.isEmpty {
                urgentSection
            }

            ConversationListSection()

            if usageAlert {
                UsageSection()
                AcceptedFeedSection()
            } else {
                AcceptedFeedSection()
                UsageSection()
            }

            if !later.isEmpty {
                laterSection
            }
        }
    }

    /// En haut, en entier : ce qui attend ta décision hors d'une conversation ouverte (elle l'affiche sous elle),
    /// et ce qui a mal tourné (autorisée mais échouée, refusée, limite atteinte), où que ce soit.
    private var urgent: [ReviewItem] {
        let open = Set(store.conversations.filter(\.isOpen).map(\.id))
        return store.toReview.filter {
            (($0.needsDecision || $0.reviewKind == .waiting) && !open.contains($0.conversationId ?? "")) || Self.important($0)
        }
    }

    private static func important(_ item: ReviewItem) -> Bool {
        (item.reviewKind == .blocked && !item.needsDecision) || item.reviewKind == .limit
    }

    /// Le reste (questions choisies pour toi…) : à relire, sans urgence.
    private var later: [ReviewItem] {
        store.toReview.filter { !($0.needsDecision || $0.reviewKind == .waiting) && !Self.important($0) }
    }

    /// Un compte qui fait tourner une conversation ouverte passe 90 % de sa semaine : la consommation remonte
    /// (un compte plein dont on ne se sert pas ne compte pas).
    private var usageAlert: Bool {
        let used = Set(store.conversations.filter(\.isOpen).compactMap(\.accountId))
        return store.accounts.contains { used.contains($0.id) && ($0.usage?.week?.pct ?? 0) >= 90 }
    }

    private var urgentSection: some View {
        CardSection {
            ForEach(urgent) { item in
                ReviewRow(item: item)
            }
        } header: {
            HStack(spacing: 6) {
                Text("À regarder")
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


    /// Fenêtre glissante d'une heure, tenue par le moteur : rien à remettre à zéro.
    private var sinceHeader: String { "Depuis une heure" }

    private var subtitle: String {
        let open = store.conversations.filter(\.isOpen)
        let working = open.count(where: { $0.state == .working })
        var parts = [Fmt.count(open.count, "conversation ouverte", "conversations ouvertes")]
        if working > 0 { parts.append("\(working) au travail") }
        return parts.joined(separator: " · ")
    }
}

/// « Depuis une heure » : une ligne de chiffres, fenêtre glissante.
struct SinceRow: View {
    @Environment(VigieStore.self) private var store

    var body: some View {
        let summary = store.sinceSummary
        HStack(alignment: .center, spacing: 16) {
            FlowStats(items: items(summary)) { status in store.openHistory(status: status, window: 60) }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }

    private func items(_ summary: SinceSummary?) -> [FlowStats.Item] {
        let accepted = summary?.accepted ?? 0
        let questions = summary?.questionsAuto ?? 0
        let blocked = summary?.blocked ?? 0
        let refused = summary?.refused ?? 0
        let failedActions = summary?.failed ?? 0
        let reports = summary?.reports ?? 0
        let failed = summary?.testsFailed ?? 0
        let limits = summary?.limits ?? 0
        // un clic sur un chiffre ouvre l'historique de l'heure, filtré sur ce statut
        var list: [FlowStats.Item] = [.init(value: accepted, label: accepted > 1 ? "acceptées" : "acceptée", history: "accepted")]
        if questions > 0 { list.append(.init(value: questions, label: questions > 1 ? "questions choisies" : "question choisie", history: "question")) }
        if refused > 0 { list.append(.init(value: refused, label: refused > 1 ? "refusées" : "refusée", history: "refused")) }
        if blocked > 0 { list.append(.init(value: blocked, label: blocked > 1 ? "bloquées" : "bloquée", alert: true, history: "blocked")) }
        if failedActions > 0 { list.append(.init(value: failedActions, label: failedActions > 1 ? "échouées" : "échouée", alert: true, history: "failed")) }
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
        /// Statut de l'historique ouvert au clic (nil : pas cliquable).
        var history: String? = nil
    }

    let items: [Item]
    var open: ((String) -> Void)? = nil

    var body: some View {
        FlowLayout(spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(spacing: 6) {
                    if index > 0 { Text("·").foregroundStyle(.tertiary) }
                    stat(item)
                }
            }
        }
        .font(.title3)
        .contentTransition(.numericText())
    }

    @ViewBuilder
    private func stat(_ item: Item) -> some View {
        let label = HStack(spacing: 4) {
            Text(Fmt.int(item.value)).bold().monospacedDigit()
                .foregroundStyle(item.alert ? AnyShapeStyle(Color.red) : AnyShapeStyle(.primary))
            Text(item.label)
                .foregroundStyle(item.alert ? AnyShapeStyle(Color.red) : AnyShapeStyle(.secondary))
        }
        .fixedSize()
        if let key = item.history, let open {
            Button { open(key) } label: { label.contentShape(.rect) }
                .buttonStyle(.plain)
                .help("Voir le détail dans l'historique")
                .pointerStyle(.link)
        } else {
            label
        }
    }
}
