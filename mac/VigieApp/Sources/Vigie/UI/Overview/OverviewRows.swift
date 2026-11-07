import SwiftUI

/// Une ligne de « À décider », « À regarder » ou « À relire » (vue d'ensemble, page d'une conversation, panneau) :
/// action sensible, question choisie pour toi, conversation qui t'attend, limite.
/// - Titre en noir ; une action sensible porte son état en puce à côté (« Refusée dans 8 min », « À autoriser »,
///   « Refusée d'office ») : c'est lui qui compte, il ne se coupe jamais. Dans la page de sa conversation, la puce
///   « À autoriser » est neutre : le verdict rouge juste au-dessus le dit déjà.
/// - Dessous, qui · quoi · quand (conversation, règle, heure), puis la commande, coupée au milieu.
/// - Les boutons ne se coupent jamais : quand la place manque, ils passent sous le texte (`ViewThatFits`, sans risque
///   dans une colonne à taille minimale fixe). Une décision a toujours « Voir · Refuser · Autoriser ».
/// - La croix « Retirer » (ce qui n'attend aucune décision) reste à part, en haut à droite, jamais à côté d'un refus.
/// - Une limite atteinte propose « Passer sur Perso » quand un autre compte connecté a de la marge (sinon « Voir les
///   comptes ») : le clic ouvre la confirmation du menu Compte de la conversation, qui dit ce que coûte la relecture.
///   Jamais automatique : sans ce choix, la conversation garde son compte.
struct ReviewRow: View {
    @Environment(VigieStore.self) private var store
    let item: ReviewItem
    /// Affichée dans la page de sa conversation : son nom n'est pas répété, et on propose d'y répondre dans VS Code.
    var inConversation = false

    /// Limite atteinte : le compte choisi au clic, en attente de la confirmation.
    @State private var pendingSwitch: Account?
    /// Bascule partie à l'instant : le bouton s'efface tout de suite, et revient si le moteur la refuse.
    @State private var switching = false

    /// Largeur sous laquelle le texte ne descend pas : en deçà, les boutons passent dessous.
    private static let textWidth: CGFloat = 240

    var body: some View {
        Group {
            // Le délai d'une action en attente se tient à jour tout seul ; le reste suit les relevés.
            if item.reviewKind == .blocked, item.isPendingDecision, item.expiresAt != nil {
                TimelineView(.periodic(from: .now, by: 5)) { context in
                    row(now: store.isDemo ? store.now : context.date)
                }
            } else {
                row(now: store.now)
            }
        }
        // la même confirmation que le menu Compte de la barre de la conversation
        .confirmationDialog(pendingSwitch.map { "Passer sur \($0.displayName) ?" } ?? "",
                            isPresented: Binding(get: { pendingSwitch != nil }, set: { if !$0 { pendingSwitch = nil } }),
                            titleVisibility: .visible, presenting: pendingSwitch) { account in
            if let conversation = switchConversation {
                let working = conversation.state == .working
                Button(working ? "À la fin de son travail" : "Passer sur \(account.displayName)") {
                    runSwitch(conversation, to: account, now: false)
                }
                if working {
                    Button("Tout de suite (l'interrompt)") { runSwitch(conversation, to: account, now: true) }
                }
            }
            Button("Annuler", role: .cancel) {}
        } message: { account in
            Text(AccountSwitch.message(working: switchConversation?.state == .working, to: account,
                                       contextTokens: switchContextTokens))
        }
    }

    private func row(now: Date) -> some View {
        HStack(alignment: .top, spacing: 10) {
            // une commande à lancer toi-même n'est pas refusée : son icône et sa couleur, celles de sa puce orange
            RowIcon(symbol: runYourself ? Icon.command : Theme.symbol(for: item.reviewKind),
                    alert: Theme.isAlert(item.reviewKind) && !runYourself)
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
            if VigieStore.canDismiss(item) {
                IconButton("Retirer", systemImage: "xmark", help: "Retirer de « À regarder »") {
                    await store.dismissReview(item)
                }
            }
        }
        .padding(.vertical, 2)
    }

    /// Une commande administrateur refusée d'office : à lancer toi-même (puce orange), pas un refus à corriger.
    private var runYourself: Bool {
        item.reviewKind == .blocked && item.needsPassword == true && !item.needsDecision && item.state != "waiting" && !item.failed
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

    /// Qui · quoi · quand. Pour une action sensible, la règle (le titre dit ce que fait l'action ; un moteur plus
    /// ancien y mettait la règle : elle n'est pas répétée) ; sinon le détail du moteur. Sur la page de sa conversation,
    /// son nom n'est pas répété.
    private var infoParts: [String?] {
        let who = inConversation ? nil : (item.conversationId.flatMap { store.conversation($0)?.shortTitle } ?? item.conversationTitle)
        let when = item.ts.map { Fmt.when($0, now: store.now) }
        if item.reviewKind == .blocked {
            return [who, item.rule.flatMap { $0.isEmpty || $0 == item.title ? nil : $0 }, when]
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
                // le même mot partout (fenêtre, barre des menus, liste « N à décider ») ; l'aide dit si elle attend en
                // pause ou si elle a continué sans
                Chip(Theme.label(for: .blocked), symbol: Icon.guardRule, tone: inConversation ? .neutral : .alert)
                    .help(item.holding == true ? "En pause : elle attend ton accord ici"
                          : item.isAwaitingApproval ? "Elle a continué sans cette action : autorise-la, elle pourra la relancer"
                          : "Elle attend ton accord")
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
                if let target = switchTarget {
                    Button("Passer sur \(target.displayName)") { pendingSwitch = target }
                        .glassButton()
                        .help(switchHelp(target))
                } else {
                    Button("Voir les comptes") {
                        store.showAccounts(item.conversationId.flatMap { store.conversation($0)?.accountId })
                    }
                    .glassButton()
                }
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
            case .other where item.conversationId == nil:
                // un avis sur un compte (à reconnecter, module Codex) : là où il se règle
                Button("Voir les comptes") { store.showAccounts(item.accountId) }
                    .glassButton()
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
        .help("Ouvre cette conversation là où elle tourne")
    }

    // MARK: Limite atteinte : passer sur un compte libre

    private var switchConversation: ConversationSummary? {
        item.conversationId.flatMap { store.conversation($0) }
    }

    /// Le compte libre sur lequel passer la conversation arrêtée par cette limite. Rien si elle a déjà changé de compte
    /// (ou va le faire), pour une conversation Codex (son compte ChatGPT), ou si aucun compte n'a de marge.
    private var switchTarget: Account? {
        guard item.reviewKind == .limit, !switching, let conversation = switchConversation, conversation.isOpen,
              !conversation.isCodex, conversation.resume == nil, conversation.account?.pending == nil else { return nil }
        let limited = item.accountId ?? conversation.accountId
        if let limited, let chosen = conversation.accountId, chosen != limited { return nil }
        return AccountSwitch.freeAccount(in: store.accounts, limited: limited, now: store.now)
    }

    /// Ce que le nouveau compte relira (le détail lu, sinon le dernier relevé de la vue d'ensemble).
    private var switchContextTokens: Int? {
        guard let id = item.conversationId else { return nil }
        return store.details[id]?.raw.contextTokens ?? store.latestConversations.first { $0.id == id }?.contextTokens
    }

    private func switchHelp(_ account: Account) -> String {
        let text = "\(account.displayName) a de la marge. Une confirmation d'abord : elle reprend dessus à ton prochain message, avec tout son historique."
        return [text, AccountSwitch.reread(on: account, contextTokens: switchContextTokens),
                AccountSwitch.size(contextTokens: switchContextTokens)].compactMap { $0 }.joined(separator: " ")
    }

    /// La même action que le menu Compte de la conversation. Le bouton s'efface tout de suite ; si le moteur refuse,
    /// il revient (la conversation n'a pas changé de compte).
    private func runSwitch(_ conversation: ConversationSummary, to account: Account, now: Bool) {
        switching = true
        Task { @MainActor in
            await store.switchAccount(of: conversation.id, to: account.id, now: now)
            switching = false
        }
    }
}
