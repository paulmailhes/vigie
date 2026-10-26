import SwiftUI

// Vue d'ensemble, en deux blocs qui se lisent d'un coup d'œil :
// « En ce moment » (chaque compte : ce qui consomme dessus, débit, session et semaine),
// puis « Conversations » (une ligne chacune : état, ce qu'elle fait, compte, débit, étapes).

extension VigieStore {
    /// Ce qui attend une décision maintenant dans cette conversation (action sensible, question, attente).
    func urgentItems(for conversationID: String) -> [ReviewItem] {
        toReview.filter { $0.conversationId == conversationID && ($0.needsDecision || $0.reviewKind == .waiting) }
    }

    /// Compte sur lequel tourne vraiment la conversation (processus lancé), sinon celui choisi.
    func runningAccountId(of conversation: ConversationSummary) -> String? {
        conversation.account?.running ?? conversation.accountId ?? account(nil)?.id
    }

    /// Conversations ouvertes qui travaillent sur ce compte, dans l'ordre de la liste.
    func working(on accountId: String) -> [ConversationSummary] {
        conversations.filter { $0.isOpen && $0.state == .working && runningAccountId(of: $0) == accountId }
    }

    /// Débit du moment sur ce compte (% de sa semaine par heure, 10 dernières minutes).
    func ratePerHour(on accountId: String) -> Double {
        conversations
            .filter { $0.isOpen && runningAccountId(of: $0) == accountId }
            .reduce(0) { $0 + ($1.rate?.weekPctPerHour ?? 0) }
    }
}

/// Titre de bloc : un mot en gras, un complément discret.
struct BlockTitle: View {
    let title: String
    var detail: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title).font(.headline)
            if let detail, !detail.isEmpty {
                Text(detail).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 6)
    }
}

/// Rangées séparées par un filet, dans un seul fond arrondi.
struct RowsBlock<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) {
            Group(subviews: content) { rows in
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    if index > 0 { Divider().padding(.leading, 40) }
                    row
                }
            }
        }
        .background(.quinary, in: .rect(cornerRadius: Theme.corner))
    }
}

// MARK: - En ce moment

// MARK: - Conversations

struct ConversationListSection: View {
    @Environment(VigieStore.self) private var store

    var body: some View {
        let open = store.conversations.filter(\.isOpen)
        VStack(alignment: .leading, spacing: 8) {
            BlockTitle(title: "Conversations", detail: Fmt.count(open.count, "ouverte", "ouvertes"))
            if open.isEmpty {
                Label("Aucune conversation ouverte", systemImage: "moon.zzz")
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
            } else {
                RowsBlock {
                    ConversationListHeader()
                    ForEach(open) { conversation in
                        // la conversation, et juste dessous ce qu'elle attend de toi, avec les boutons
                        VStack(spacing: 0) {
                            ConversationListRow(conversation: conversation,
                                                data: CardData(summary: conversation, detail: store.details[conversation.id]?.raw,
                                                               since: store.since, now: store.now),
                                                sensitive: sensitiveItem(for: conversation.id))
                            let waiting = store.urgentItems(for: conversation.id)
                            if !waiting.isEmpty {
                                VStack(spacing: 0) {
                                    ForEach(waiting) { item in
                                        ReviewRow(item: item)
                                            .padding(.horizontal, 12)
                                            .padding(.vertical, 8)
                                    }
                                }
                                .background(Theme.alert.opacity(0.06), in: .rect(cornerRadius: 10))
                                .padding(.leading, 40)
                                .padding(.trailing, 12)
                                .padding(.bottom, 10)
                            }
                        }
                    }
                }
            }
        }
    }

    /// L'action sensible de la conversation : celle qui attend ta décision d'abord.
    private func sensitiveItem(for id: String) -> ReviewItem? {
        let items = store.toReview.filter { $0.conversationId == id && $0.reviewKind == .blocked }
        return items.first(where: \.needsDecision) ?? items.first
    }
}

/// Largeurs des colonnes de droite, communes à l'en-tête et aux rangées.
private enum Column {
    static let account: CGFloat = 96
    static let rate: CGFloat = 112
    static let steps: CGFloat = 56
}

struct ConversationListHeader: View {
    var body: some View {
        HStack(spacing: 12) {
            Text("")
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("Compte").frame(width: Column.account, alignment: .trailing)
            Text("Consommation").frame(width: Column.rate, alignment: .trailing)
            Text("Étapes").frame(width: Column.steps, alignment: .trailing)
        }
        .font(.caption)
        .foregroundStyle(.tertiary)
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .padding(.bottom, 2)
    }
}

/// Une conversation : pastille, nom, ce qu'elle fait ; ce qui t'attend en rouge ; compte, débit, étapes.
struct ConversationListRow: View {
    @Environment(VigieStore.self) private var store
    let conversation: ConversationSummary
    let data: CardData
    let sensitive: ReviewItem?

    @State private var hovering = false

    private var working: Bool { conversation.state == .working }

    var body: some View {
        HStack(spacing: 12) {
            StatusDot(status: conversation.state, size: 9)
                .frame(width: 14)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(conversation.shortTitle)
                        .font(.body.weight(.semibold))
                        .lineLimit(1)
                    warnings
                }
                Text(line)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            attention
            accountCell
                .frame(width: Column.account, alignment: .trailing)
            rateCell
                .frame(width: Column.rate, alignment: .trailing)
            Text(data.hasProgress ? "\(data.progressDone)/\(data.progressTotal)" : "")
                .font(.callout)
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(width: Column.steps, alignment: .trailing)
                .help(data.progressLabel ?? "Étapes faites")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(hovering ? AnyShapeStyle(.quaternary.opacity(0.5)) : AnyShapeStyle(.clear))
        .contentShape(.rect)
        .onHover { hovering = $0 }
        .onTapGesture { store.route = .conversation(conversation.id) }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("\(conversation.shortTitle), \(Theme.label(for: conversation.state))")
        .accessibilityAction { store.route = .conversation(conversation.id) }
    }

    /// Ce qu'elle fait : l'étape en cours, sinon le dernier résumé, sinon son état.
    private var line: String {
        if let current = data.current, !current.isEmpty { return current }
        if let headline = conversation.headline, !headline.isEmpty { return headline }
        return Theme.label(for: conversation.state)
    }

    /// À surveiller (orange) : s'emballe, tests en échec. Le détail au survol.
    @ViewBuilder
    private var warnings: some View {
        if let alert = conversation.alert, alert.isRunaway {
            Image(systemName: Icon.runaway)
                .imageScale(.small)
                .foregroundStyle(Theme.warn)
                .help("S'emballe : \(alert.reason ?? "consommation anormale")")
        }
        if let agents = conversation.agentsRunning, agents > 0 {
            Label(Fmt.int(agents), systemImage: Icon.agent)
                .labelStyle(CompactLabelStyle())
                .font(.caption)
                .foregroundStyle(.secondary)
                .help(Fmt.count(agents, "agent au travail", "agents au travail"))
        }
        if data.testsFailed > 0 {
            Label(Fmt.int(data.testsFailed), systemImage: Icon.testFailed)
                .labelStyle(CompactLabelStyle())
                .font(.caption.weight(.medium))
                .foregroundStyle(Theme.warn)
                .help(Fmt.count(data.testsFailed, "test en échec", "tests en échec"))
        }
    }

    /// Ce qui t'attend (rouge) : une action à autoriser, une question, une attente.
    @ViewBuilder
    private var attention: some View {
        if !store.urgentItems(for: conversation.id).isEmpty {
            EmptyView()
        } else if let resume = conversation.resume {
            AsyncButton {
                await store.openConversationInVSCode(conversation.id, cwd: conversation.cwd)
            } label: {
                Pill(text: "À relancer", alert: true, symbol: "arrow.clockwise")
            }
            .buttonStyle(.plain)
            .help("Arrêtée pour passer sur \(store.account(resume.to)?.displayName ?? "l'autre compte") : écris-lui un message dans VS Code et elle repart dessus. Clic : ouvrir la conversation.")
        } else if let sensitive, sensitive.needsDecision || sensitive.isAwaitingApproval {
            Button {
                store.blockedRequest = sensitive
            } label: {
                Pill(text: "À autoriser", alert: true, symbol: Icon.guardRule)
            }
            .buttonStyle(.plain)
            .help(sensitive.rule ?? sensitive.title ?? "Action sensible")
        } else if Theme.needsYou(conversation.state) {
            Pill(text: "T'attend", alert: true, symbol: Icon.waiting)
                .help(conversation.waitingFor ?? "T'attend")
        }
    }

    @ViewBuilder
    private var accountCell: some View {
        let running = conversation.resume?.to ?? store.runningAccountId(of: conversation)
        let pending = conversation.account?.pending?.to
        VStack(alignment: .trailing, spacing: 1) {
            Text(store.account(running)?.displayName ?? running ?? "—")
                .foregroundStyle(working ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
            if let pending, pending != running {
                Text("→ \(store.account(pending)?.displayName ?? pending)")
                    .font(.caption)
                    .foregroundStyle(Theme.warn)
            }
        }
        .font(.callout)
        .lineLimit(1)
        .help(pending.map { "Tourne sur \(store.account(running)?.displayName ?? "?"), passe sur \(store.account($0)?.displayName ?? $0) à la fin de son tour" }
              ?? "Tourne sur \(store.account(running)?.displayName ?? "?")")
    }

    @ViewBuilder
    private var rateCell: some View {
        if let rate = conversation.rate, (rate.tokensPerMin ?? 0) > 0 || (rate.weekPctPerHour ?? 0) > 0.005 {
            RateBadge(rate: rate, alert: conversation.alert?.isRunaway == true, compact: true, live: working)
        }
    }
}
