import SwiftUI

/// Une ligne de « À décider », « À regarder » ou « À relire » (vue d'ensemble, page d'une conversation, panneau) :
/// action sensible, question choisie pour toi, conversation qui t'attend, limite.
/// - Titre en noir ; une action sensible porte son état en puce à côté (« Refusée dans 8 min », « Attend ton
///   accord », « Refusée d'office ») : c'est lui qui compte, il ne se coupe jamais.
/// - Dessous, qui · quoi · quand (conversation, règle, heure), puis la commande, coupée au milieu.
/// - Les boutons ne se coupent jamais : quand la place manque, ils passent sous le texte (`ViewThatFits`, sans risque
///   dans une colonne à taille minimale fixe). Une décision a toujours « Voir · Refuser · Autoriser ».
/// - La croix « Retirer » (ce qui n'attend aucune décision) reste à part, en haut à droite, jamais à côté d'un refus.
struct ReviewRow: View {
    @Environment(VigieStore.self) private var store
    let item: ReviewItem
    /// Affichée dans la page de sa conversation : son nom n'est pas répété, et on propose d'y répondre dans VS Code.
    var inConversation = false

    /// Largeur sous laquelle le texte ne descend pas : en deçà, les boutons passent dessous.
    private static let textWidth: CGFloat = 240

    var body: some View {
        // Le délai d'une action en attente se tient à jour tout seul ; le reste suit les relevés.
        if item.reviewKind == .blocked, item.isPendingDecision, item.expiresAt != nil {
            TimelineView(.periodic(from: .now, by: 5)) { context in
                row(now: store.isDemo ? store.now : context.date)
            }
        } else {
            row(now: store.now)
        }
    }

    private func row(now: Date) -> some View {
        HStack(alignment: .top, spacing: 10) {
            RowIcon(symbol: Theme.symbol(for: item.reviewKind), alert: Theme.isAlert(item.reviewKind))
                .padding(.top, 1)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) {
                    text(now: now)
                        .frame(minWidth: 0, idealWidth: Self.textWidth, maxWidth: .infinity, alignment: .leading)
                    actions(stacked: false)
                }
                VStack(alignment: .leading, spacing: 8) {
                    text(now: now)
                        .frame(minWidth: 0, idealWidth: 0, maxWidth: .infinity, alignment: .leading)
                    actions(stacked: false)
                }
                VStack(alignment: .leading, spacing: 8) {
                    text(now: now)
                        .frame(minWidth: 0, idealWidth: 0, maxWidth: .infinity, alignment: .leading)
                    actions(stacked: true)
                }
            }
            if VigieStore.isLook(item) {
                IconButton("Retirer", systemImage: "xmark", help: "Retirer de « À regarder »") {
                    await store.dismissReview(item)
                }
            }
        }
        .padding(.vertical, 2)
    }

    // MARK: Texte

    private func text(now: Date) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(headline)
                    .textRole(.event)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .help(item.detail ?? headline)
                stateChip(now: now)
            }
            InfoLine(parts: infoParts)
            if item.needsDecision, let command = item.command, !command.isEmpty {
                CodeLine(command)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var headline: String {
        let title = item.title ?? ""
        return item.reviewKind == .question ? "« \(title) »" : title
    }

    /// Qui · quoi · quand. Pour une action sensible, la règle (le détail du moteur va au survol du titre) ; sinon le
    /// détail du moteur. Sur la page de sa conversation, son nom n'est pas répété.
    private var infoParts: [String?] {
        let who = inConversation ? nil : (item.conversationId.flatMap { store.conversation($0)?.shortTitle } ?? item.conversationTitle)
        let when = item.ts.map { Fmt.when($0, now: store.now) }
        if item.reviewKind == .blocked, let rule = item.rule, !rule.isEmpty {
            return [who, rule, when]
        }
        return [who, item.detail, when]
    }

    /// L'état d'une action sensible, en puce : ce qui demande un geste ne se perd jamais dans la ligne grise.
    @ViewBuilder
    private func stateChip(now: Date) -> some View {
        if item.reviewKind == .blocked {
            if item.isPendingDecision, let expires = item.expiresAt {
                Chip(expires > now ? "Refusée \(Fmt.remaining(until: expires, now: now))" : "Refusée d'office",
                     symbol: "timer", tone: .alert)
                    .help("Sans réponse, Vigie la refuse d'office \(Fmt.reset(expires, now: now))")
            } else if item.needsDecision {
                Chip("Attend ton accord", symbol: Icon.guardRule, tone: .alert)
            } else if item.state == "waiting" {
                Chip("À décider dans VS Code", tone: .alert)
            } else if item.failed {
                Chip("En échec", tone: .alert)
            } else if item.needsPassword == true {
                Chip("À lancer toi-même", symbol: Icon.command, tone: .warn)
            } else {
                Chip("Refusée d'office", tone: .alert)
            }
        }
    }

    // MARK: Boutons

    private var replyLabel: String {
        item.conversationId.flatMap { store.conversation($0)?.replyLabel } ?? "Répondre dans VS Code"
    }

    /// `stacked` : la place manque même sous le texte, « Voir » passe sur sa propre ligne, au-dessus de la décision.
    @ViewBuilder
    private func actions(stacked: Bool) -> some View {
        Group {
            switch item.reviewKind {
            case .question:
                HStack(spacing: 6) {
                    AsyncButton("Ça me va") { await store.acceptReview(item) }
                    Button("Changer…") { store.changeRequest = item }
                }
                .glassButton()
            case .limit:
                Button("Voir les comptes") {
                    store.showAccounts(item.conversationId.flatMap { store.conversation($0)?.accountId })
                }
                .glassButton()
            case .blocked where item.needsDecision:
                if stacked {
                    VStack(alignment: .leading, spacing: 6) {
                        Button("Voir") { store.blockedRequest = item }
                            .glassButton()
                            .help("La commande en entier")
                        ReviewDecisionButtons(item: item, showSee: false)
                    }
                } else {
                    ReviewDecisionButtons(item: item)
                }
            case .blocked:
                Button("Voir") { store.blockedRequest = item }
                    .glassButton()
                    .help("La commande et quoi faire")
            case .waiting where !item.questions.isEmpty && item.pendingId != nil:
                Button("Répondre…") { store.answerRequest = item }
                    .glassButton(.primary)
                    .help("Voir la question et y répondre d'ici")
            case .waiting, .other:
                if inConversation {
                    replyButton
                } else {
                    HStack(spacing: 6) {
                        Button("Voir") {
                            if let id = item.conversationId { store.route = .conversation(id) }
                        }
                        .glassButton()
                        .disabled(item.conversationId == nil)
                        if item.conversationId != nil {
                            replyButton
                        }
                    }
                }
            }
        }
        .fixedSize()
    }

    private var replyButton: some View {
        AsyncButton(replyLabel) {
            await store.openConversationInVSCode(item.conversationId, cwd: item.cwd)
        }
        .glassButton(.primary)
        .help("Ouvre cette conversation dans VS Code")
    }
}
