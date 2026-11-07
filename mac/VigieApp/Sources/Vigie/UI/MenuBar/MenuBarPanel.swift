import SwiftUI

/// L'icône de la barre des menus : jumelles pleines quand l'auto-accept est activé, et LE badge rouge (les décisions
/// qui t'attendent, le même chiffre que la barre latérale et le panneau).
struct MenuBarLabel: View {
    let store: VigieStore

    var body: some View {
        let count = store.reviewBadge
        HStack(spacing: 3) {
            Image(systemName: store.autoAcceptBadge ? "binoculars.fill" : "binoculars")
            if count > 0 {
                Text("\(count)")
                    .monospacedDigit()
            }
        }
        .accessibilityLabel(count > 0 ? "Vigie, \(count) à décider" : "Vigie")
    }
}

/// Le panneau compact de la barre des menus : une seule carte, ses groupes titrés en surtitre (`CardTitle`).
/// Un clic mène à l'élément dans la fenêtre : une décision ouvre sa conversation puis sa fiche.
struct MenuBarPanel: View {
    @Environment(VigieStore.self) private var store
    @Environment(\.openWindow) private var openWindow

    /// Décisions montrées dans le panneau ; les autres sont dans la Vue d'ensemble.
    private static let shownDecisions = 3

    var body: some View {
        @Bindable var store = store
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: store.autoAccept ? "binoculars.fill" : "binoculars")
                    .font(.title2)
                    .foregroundStyle(.secondary)
                    .contentTransition(.symbolEffect(.replace))
                VStack(alignment: .leading, spacing: 0) {
                    Text("Auto-accept").font(.headline)
                    Text(store.autoAccept ? "Vigie accepte pour toi, sauf les actions sensibles" : "Claude te demande à chaque fois")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Toggle("Auto-accept", isOn: $store.autoAccept)
                    .toggleStyle(.switch)
                    .labelsHidden()
            }

            if store.connection == .down {
                HStack(spacing: 8) {
                    Label("Le moteur de Vigie ne répond pas", systemImage: "bolt.horizontal.circle")
                        .foregroundStyle(Theme.alertText)
                        .font(.callout)
                    Spacer()
                    Button("Relancer") { store.restartEngine() }
                        .glassButton()
                        .controlSize(.small)
                }
            }

            Divider()

            CardTitle("En ce moment")
            PanelAccounts()

            let decisions = store.decisionItems
            if !decisions.isEmpty {
                Divider()
                HStack(spacing: 6) {
                    CardTitle("À décider")
                    CountBadge(count: decisions.count, urgent: true)
                }
                ForEach(decisions.prefix(Self.shownDecisions)) { item in
                    Button {
                        store.open(review: item)
                        showWindow()
                    } label: {
                        DecisionSummary(item: item)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 3)
                    }
                    .buttonStyle(TileButtonStyle())
                    .padding(.horizontal, -6)
                }
                if decisions.count > Self.shownDecisions {
                    Button("et \(decisions.count - Self.shownDecisions) autres") { open(.overview) }
                        .buttonStyle(.link)
                        .font(.callout)
                        .help("Toutes les décisions, dans la Vue d'ensemble")
                }
            }

            Divider()

            let openConversations = store.conversations.filter(\.isOpen)
            CardTitle("Conversations", trailing: openConversations.isEmpty ? nil : Fmt.int(openConversations.count))
            if openConversations.isEmpty {
                Text("Aucune conversation ouverte")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            ForEach(openConversations) { conversation in
                Button {
                    open(.conversation(conversation.id))
                } label: {
                    HStack(spacing: 8) {
                        StatusDot(status: conversation.state)
                        Text(conversation.shortTitle)
                            .lineLimit(1)
                            .layoutPriority(1)
                        if let alert = conversation.alert, alert.isRunaway {
                            Image(systemName: Icon.runaway)
                                .foregroundStyle(Theme.warn)
                                .imageScale(.small)
                                .help(alert.reason ?? "S'emballe")
                        }
                        Spacer(minLength: 4)
                        if let rate = conversation.rate, (rate.tokensPerMin ?? 0) > 0 {
                            RateBadge(rate: rate, alert: conversation.alert?.isRunaway == true, compact: true,
                                      live: conversation.state == .working)
                                .font(.caption)
                        }
                        ConversationTrail(conversation: conversation, accountWidth: 62)
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .contentShape(.rect)
                }
                .buttonStyle(TileButtonStyle())
                .padding(.horizontal, -6)
                .help(conversation.title ?? conversation.shortTitle)
                .accessibilityLabel(ConversationTrail.spoken(conversation, store: store))
            }

            if let background = store.backgroundSummary, let count = background.forgotten, count > 0 {
                Button {
                    open(.background)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "memorychip")
                            .foregroundStyle(Theme.warn)
                        Text("En fond : \(Fmt.count(count, "oublié")) · \(Fmt.memory(mb: background.forgottenMb))")
                        Spacer(minLength: 4)
                        Image(systemName: "chevron.right")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .contentShape(.rect)
                }
                .buttonStyle(TileButtonStyle())
                .padding(.horizontal, -6)
                .help("Leurs conversations sont fermées : tu peux les arrêter dans En fond")
            }

            Divider()

            HStack {
                Button("Ouvrir Vigie", systemImage: "macwindow") { open(nil) }
                    .glassButton(.primary)
                Spacer()
                SettingsLink {
                    Label("Réglages", systemImage: "gearshape")
                }
                .labelStyle(.iconOnly)
                .glassButton()
                .help("Réglages : garde-fous, notifications, mises à jour")
                Button("Quitter Vigie", systemImage: "power") { NSApplication.shared.terminate(nil) }
                    .labelStyle(.iconOnly)
                    .glassButton()
                    .help("Quitter Vigie")
            }
        }
        .padding(16)
        .frame(width: 380)
        // ouvert : relu tout de suite, puis toutes les 3 s (fenêtre cachée, la vue d'ensemble l'est moins souvent)
        .onAppear { store.menuPanelOpen = true }
        .onDisappear { store.menuPanelOpen = false }
    }

    private func open(_ route: Route?) {
        if let route { store.route = route }
        showWindow()
    }

    private func showWindow() {
        openWindow(id: VigieApp.mainWindowID)
        NSApplication.shared.activate()
    }
}

/// Chaque compte : pastille verte s'il consomme, ce qui tourne dessus, débit, session et semaine. Une fenêtre pleine
/// s'écrit en toutes lettres, en rouge (« Session pleine · 03:40 »), comme dans la barre latérale ; une semaine qui
/// serait pleine avant sa remise à zéro le dit dessous, en orange (`WeekForecast`).
struct PanelAccounts: View {
    @Environment(VigieStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(store.accounts) { account in
                let gauge = AccountGauge(usage: account.usage, now: store.now)
                VStack(alignment: .leading, spacing: 2) {
                    row(account)
                    if account.isConnected, let forecast = gauge.forecast {
                        Text(forecast)
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(Theme.warnText)
                            .fixedSize(horizontal: false, vertical: true)
                            // sous le nom du compte (pastille de 7 pt et écart de 8)
                            .padding(.leading, 15)
                    }
                }
                .help(gauge.help)
            }
        }
    }

    private func row(_ account: Account) -> some View {
        let working = store.working(on: account.id)
        let rate = store.ratePerHour(on: account.id)
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle()
                .fill(working.isEmpty ? AnyShapeStyle(.quaternary) : AnyShapeStyle(Theme.live))
                .frame(width: 7, height: 7)
                .opacity(account.isConnected ? 1 : Theme.dim)
            VStack(alignment: .leading, spacing: 1) {
                Text(account.displayName)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(account.isConnected ? .primary : .secondary)
                Text(account.isConnected ? (working.isEmpty ? "Rien ne tourne" : working.map(\.shortTitle).joined(separator: ", "))
                     : "Pas connecté")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            if account.isConnected {
                if rate > 0.005 {
                    Text(Fmt.rate(rate))
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .help("Débit des 10 dernières minutes, en % de la semaine par heure")
                }
                VStack(alignment: .trailing, spacing: 1) {
                    usage("Session", account.usage?.session, session: true)
                    usage("Semaine", account.usage?.week, session: false)
                }
                .font(.caption)
            }
        }
    }

    @ViewBuilder
    private func usage(_ title: String, _ window: UsageWindow?, session: Bool) -> some View {
        if let full = AccountGauge.fullText(window, session: session) {
            Text(full)
                .fontWeight(.medium)
                .monospacedDigit()
                .foregroundStyle(Theme.alertText)
                .help(AccountGauge.describe(title, window, now: store.now) ?? title)
        } else {
            HStack(spacing: 3) {
                Text(title).foregroundStyle(.secondary)
                Text(Fmt.pct(window?.pct))
                    .monospacedDigit()
                    .foregroundStyle(window?.pct.map { $0 >= 80 ? AnyShapeStyle(Theme.warnText) : AnyShapeStyle(.primary) } ?? AnyShapeStyle(.secondary))
            }
            .help(AccountGauge.describe(title, window, now: store.now) ?? title)
        }
    }
}

/// Une décision en deux lignes, la même dans le panneau de la barre des menus et la liste « À décider » de la barre
/// d'outils : ce qu'elle demande, puis le délai d'abord (« Refusée dans 8 min ») et le contexte en fin de ligne,
/// coupé ; le texte entier au survol.
struct DecisionSummary: View {
    @Environment(VigieStore.self) private var store
    let item: ReviewItem

    var body: some View {
        HStack(spacing: 8) {
            RowIcon(symbol: Theme.symbol(for: item.reviewKind), alert: true)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title ?? Theme.label(for: item.reviewKind == .blocked ? .blocked : .waiting))
                    .font(.callout)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    DecisionDeadline(item: item)
                    Text(context)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            Spacer(minLength: 0)
        }
        .contentShape(.rect)
        .help(InfoLine.text([item.title, context, DecisionDeadline.text(item, now: store.now)?.text]))
    }

    /// Qui · quoi : la conversation, puis la règle (action sensible) ou ce qu'elle attend.
    private var context: String {
        let who = item.conversationId.flatMap { store.conversation($0)?.shortTitle } ?? item.conversationTitle
        let what = item.reviewKind == .blocked ? item.rule : item.detail
        return InfoLine.text([who, what])
    }
}

/// Le délai d'une décision, en puce : « Refusée dans 8 min » (tenu à jour), « À autoriser » (elle a continué sans,
/// attend ton accord pour la relancer), « À répondre » (question à laquelle répondre d'ici). Rien pour « T'attend » :
/// son titre le dit déjà.
struct DecisionDeadline: View {
    @Environment(VigieStore.self) private var store
    let item: ReviewItem

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            if let chip = Self.text(item, now: store.isDemo ? store.now : context.date) {
                Chip(chip.text, tone: chip.tone)
            }
        }
    }

    static func text(_ item: ReviewItem, now: Date) -> (text: String, tone: Chip.Tone)? {
        switch item.reviewKind {
        case .blocked:
            if let expires = item.expiresAt, expires > now {
                return ("Refusée \(Fmt.remaining(until: expires, now: now))", .alert)
            }
            return (Theme.label(for: .blocked), .alert)
        case .waiting where !item.questions.isEmpty && item.pendingId != nil:
            return ("À répondre", .alert)
        case .waiting, .question, .limit, .other:
            return nil
        }
    }
}
