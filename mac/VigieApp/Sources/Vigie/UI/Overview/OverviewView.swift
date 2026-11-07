import SwiftUI

/// Vue d'ensemble, dans un ordre fixe (un bloc apparaît ou disparaît, il ne change pas de place) :
/// 1. « À décider » : toutes les décisions, quelle que soit la conversation, la plus proche du refus d'abord ;
/// 2. « À regarder » : ce qui a mal tourné ou que tu dois faire toi-même (refus d'office, commande à lancer toi-même,
///    limite), juste dessous pour ne jamais tomber sous le bas de la fenêtre ;
/// 3. « Conversations » : une rangée chacune, avec sa pastille, et le compte rendu de celles qui ont fini ;
/// 4. « À relire » : la fin des conversations fermées depuis (elles n'ont plus de rangée), puis ce que Vigie a choisi
///    pour toi ; 3 lignes, puis « Tout afficher » ;
/// 5. « Consommation » : une ligne par compte (le graphique est dans la page Comptes). Exception à l'ordre : elle
///    passe juste sous « À regarder » quand un compte qui fait tourner une conversation dépasse 90 % de sa semaine ;
/// 6. « Depuis une heure » : les chiffres de l'heure, chacun ouvre l'Historique. Autre exception : au retour d'une
///    absence de plus de 2 h, elle devient « Pendant ton absence » (« Depuis 23:10. » dessous) et monte juste sous
///    « À regarder », puis redevient « Depuis une heure » d'elle-même 30 min après le retour (pas de bouton « J'ai vu »).
struct OverviewView: View {
    @Environment(VigieStore.self) private var store
    @State private var showAllReread = false

    private static let rereadShown = 3

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
        let decisions = store.decisionItems
        let look = store.lookItems(for: nil)
        let reread = store.rereadItems(for: nil)
        let ends = store.closedEnds()
        return Page {
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

            if !decisions.isEmpty {
                CardSection("À décider", count: decisions.count, urgent: true) {
                    ForEach(decisions) { item in
                        ReviewRow(item: item)
                    }
                }
            }

            if !look.isEmpty {
                CardSection("À regarder", count: look.count) {
                    ForEach(look) { item in
                        ReviewRow(item: item)
                    }
                }
            }

            if store.absenceFrom != nil {
                SinceSection()
            }

            if usageAlert {
                AccountUsageSection()
            }

            ConversationListSection()

            if !reread.isEmpty || !ends.isEmpty {
                let total = reread.count + ends.count
                let shownEnds = showAllReread ? ends : Array(ends.prefix(Self.rereadShown))
                let room = showAllReread ? reread.count : max(0, Self.rereadShown - shownEnds.count)
                CardSection("À relire", count: total) {
                    ForEach(shownEnds, id: \.stableKey) { end in
                        FinishedReportRow(conversation: end.conversationId.flatMap { store.conversation($0) }, report: end,
                                          standalone: true)
                    }
                    ForEach(Array(reread.prefix(room))) { item in
                        ReviewRow(item: item)
                    }
                    if !showAllReread && total > Self.rereadShown {
                        ShowAllButton(count: total) { showAllReread = true }
                    }
                }
            }

            if !usageAlert {
                AccountUsageSection()
            }

            if store.absenceFrom == nil {
                SinceSection()
            }
        }
    }

    /// Un compte qui fait tourner une conversation ouverte passe 90 % de sa semaine : la consommation remonte
    /// (un compte plein dont on ne se sert pas ne compte pas).
    private var usageAlert: Bool {
        let used = Set(store.conversations.filter(\.isOpen).compactMap(\.accountId))
        return store.accounts.contains { used.contains($0.id) && ($0.usage?.week?.pct ?? 0) >= 90 }
    }

    /// « 3 à décider · 4 conversations ouvertes · 3 au travail » : le chiffre rouge de la barre latérale se relit ici.
    private var subtitle: String {
        let open = store.conversations.filter(\.isOpen)
        let working = open.count(where: { $0.state == .working })
        var parts: [String] = []
        let decisions = store.decisionCount
        if decisions > 0 { parts.append("\(Fmt.int(decisions)) à décider") }
        parts.append(Fmt.count(open.count, "conversation ouverte", "conversations ouvertes"))
        if working > 0 { parts.append("\(Fmt.int(working)) au travail") }
        return parts.joined(separator: " · ")
    }
}

/// « Depuis une heure » (fenêtre glissante tenue par le moteur : rien à remettre à zéro), ou « Pendant ton absence »
/// (« Depuis 23:10. » dessous) dans les 30 min qui suivent ton retour. La note et les chiffres viennent de la même
/// réponse.
struct SinceSection: View {
    @Environment(VigieStore.self) private var store

    var body: some View {
        if let from = store.absenceFrom {
            CardSection("Pendant ton absence",
                        note: "Depuis \(Fmt.when(from, now: store.now))."
                            + (store.absenceCapped ? " Ton absence a commencé plus tôt : voici les dernières 24 h." : "")) {
                SinceRow(absent: true)
            }
        } else {
            CardSection("Depuis une heure") {
                SinceRow(absent: false)
            }
        }
    }
}

/// Une ligne de chiffres. Seulement ce qui ne se lit pas déjà plus haut (les tests en échec sont sur la rangée de
/// leur conversation, une limite reste dans « À regarder »). Chaque chiffre ouvre l'Historique : la dernière heure,
/// ou les dernières 24 h après une absence (l'Historique n'a pas de période plus fine : l'aide le dit).
struct SinceRow: View {
    @Environment(VigieStore.self) private var store
    var absent = false

    var body: some View {
        FlowStats(items: items(store.sinceSummary)) { status in store.openHistory(status: status, window: absent ? 1440 : 60) }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 2)
    }

    private func items(_ summary: SinceSummary?) -> [FlowStats.Item] {
        let accepted = summary?.accepted ?? 0
        let questions = summary?.questionsAuto ?? 0
        let blocked = summary?.blocked ?? 0
        let refused = summary?.refused ?? 0
        let failed = summary?.failed ?? 0
        let results = summary?.reports ?? 0
        // un clic sur un chiffre ouvre l'historique de l'heure (après une absence, des dernières 24 h), filtré sur ce
        // statut
        let see = absent ? "voir les dernières 24 h dans l'historique" : "voir le détail dans l'historique"
        let help = ConversationVerdict.sentence(see)
        var list: [FlowStats.Item] = [.init(value: accepted, label: accepted > 1 ? "acceptées" : "acceptée", history: "accepted", help: help)]
        if questions > 0 {
            list.append(.init(value: questions, label: questions > 1 ? "questions choisies pour toi" : "question choisie pour toi",
                              history: "question", help: help))
        }
        if refused > 0 {
            list.append(.init(value: refused, label: refused > 1 ? "refusées par toi" : "refusée par toi", history: "refused", help: help))
        }
        if blocked > 0 {
            list.append(.init(value: blocked, label: blocked > 1 ? "refusées d'office" : "refusée d'office", alert: true, history: "blocked",
                              help: help))
        }
        if failed > 0 {
            list.append(.init(value: failed, label: "en échec", alert: true, history: "failed", help: "Autorisées, mais en échec : \(see)"))
        }
        if results > 0 {
            list.append(.init(value: results, label: results > 1 ? "résultats" : "résultat",
                              help: "Livrables publiés, workflows et agents finis \(absent ? "pendant ton absence" : "dans l'heure") ; une demande finie se lit sous sa conversation (dans « À relire » si elle est fermée)"))
        }
        return list
    }
}

/// Chiffres en gras suivis d'un mot plus petit et gris, séparés par des points ; retour à la ligne si la place manque.
struct FlowStats: View {
    struct Item: Hashable {
        var value: Int
        var label: String
        var alert = false
        /// Statut de l'historique ouvert au clic (nil : pas cliquable).
        var history: String? = nil
        var help: String? = nil
    }

    let items: [Item]
    var open: ((String) -> Void)? = nil

    var body: some View {
        FlowLayout(spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if index > 0 { Text("·").foregroundStyle(.tertiary) }
                    stat(item)
                }
            }
        }
    }

    @ViewBuilder
    private func stat(_ item: Item) -> some View {
        let label = HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(Fmt.int(item.value))
                .font(.title3.bold())
                .monospacedDigit()
                .contentTransition(.numericText())
                .foregroundStyle(item.alert ? AnyShapeStyle(Theme.alertText) : AnyShapeStyle(.primary))
            Text(item.label)
                .font(.body)
                .foregroundStyle(item.alert ? AnyShapeStyle(Theme.alertText) : AnyShapeStyle(.secondary))
        }
        .fixedSize()
        if let key = item.history, let open {
            Button { open(key) } label: { label.contentShape(.rect) }
                .buttonStyle(.plain)
                .help(item.help ?? "Voir le détail dans l'historique")
                .pointerStyle(.link)
        } else {
            label
                .help(item.help ?? "")
        }
    }
}
