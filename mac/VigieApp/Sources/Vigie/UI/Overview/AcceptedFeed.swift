import SwiftUI

/// Une ligne du fil : quoi (icône du type), dans quelle conversation, quand.
struct FeedRow: View {
    @Environment(VigieStore.self) private var store
    let item: FeedItem

    var body: some View {
        HStack(spacing: 10) {
            ActionIcon(kind: item.kind, service: item.service, hint: "\(item.title) \(item.detail ?? "")")
            Text(item.title)
                .lineLimit(1)
                .help(item.detail ?? item.title)
            Spacer(minLength: 8)
            Text(item.conversationTitle)
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .fixedSize()
            Text(item.ts.map { Fmt.when($0, now: store.now) } ?? "")
                .font(.callout)
                .monospacedDigit()
                .foregroundStyle(.tertiary)
                .frame(minWidth: 44, alignment: .trailing)
        }
        .contentShape(.rect)
        .onTapGesture {
            if let id = item.conversationId { store.route = .conversation(id) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}

/// « Dernières acceptations » : 10 lignes, puis « Tout afficher ».
struct AcceptedFeedSection: View {
    @Environment(VigieStore.self) private var store
    @State private var showAll = false

    private static let shown = 10

    var body: some View {
        let items = FeedItem.build(store: store)
        if !items.isEmpty {
            CardSection {
                ForEach(showAll ? items : Array(items.prefix(Self.shown))) { item in
                    FeedRow(item: item)
                }
                if !showAll && items.count > Self.shown {
                    ShowAllButton(count: items.count) { showAll = true }
                }
            } header: {
                Text("Dernières acceptations")
            }
        }
    }
}
