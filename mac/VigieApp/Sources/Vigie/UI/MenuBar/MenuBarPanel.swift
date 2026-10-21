import SwiftUI

/// L'icône de la barre des menus : jumelles pleines quand l'auto-accept est activé.
struct MenuBarLabel: View {
    let store: VigieStore

    var body: some View {
        let count = store.toReviewCount
        HStack(spacing: 3) {
            Image(systemName: store.autoAccept ? "binoculars.fill" : "binoculars")
            if count > 0 {
                Text("\(count)")
                    .monospacedDigit()
            }
        }
        .accessibilityLabel("Vigie, \(count) à regarder")
    }
}

/// Le panneau compact de la barre des menus.
struct MenuBarPanel: View {
    @Environment(VigieStore.self) private var store
    @Environment(\.openWindow) private var openWindow

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
                    Text(store.autoAccept ? "Claude valide tout seul" : "Claude te demande")
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
                    Label("Le moteur ne répond pas", systemImage: "bolt.horizontal.circle")
                        .foregroundStyle(.red)
                        .font(.callout)
                    Spacer()
                    Button("Relancer") { store.restartEngine() }
                        .glassButton()
                        .controlSize(.small)
                }
            }

            Divider()

            Text("En ce moment").font(.subheadline.bold())
            PanelAccounts()

            let urgent = store.toReview.filter { $0.needsDecision || $0.reviewKind == .waiting }
            if !urgent.isEmpty {
                Divider()
                HStack(spacing: 6) {
                    Text("À décider").font(.subheadline.bold())
                    CountBadge(count: urgent.count, urgent: true)
                }
                ForEach(urgent.prefix(3)) { item in
                    Button {
                        if item.reviewKind == .blocked { store.blockedRequest = item }
                        open(.overview)
                    } label: {
                        PanelReviewRow(item: item)
                    }
                    .buttonStyle(.plain)
                }
                if urgent.count > 3 {
                    Text("et \(urgent.count - 3) autres")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Divider()

            Text("Conversations").font(.subheadline.bold())
            let openConversations = store.conversations.filter(\.isOpen)
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
                        Text(store.account(store.runningAccountId(of: conversation))?.displayName ?? "")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .frame(width: 62, alignment: .trailing)
                        if let count = conversation.needsYou, count > 0 {
                            CountBadge(count: count, urgent: Theme.needsYou(conversation.state))
                        }
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(conversation.shortTitle), \(Theme.label(for: conversation.state))")
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
                .help("Réglages : garde-fous et notifications")
                Button("Quitter Vigie", systemImage: "power") { NSApplication.shared.terminate(nil) }
                    .labelStyle(.iconOnly)
                    .glassButton()
                    .help("Quitter Vigie")
            }
        }
        .padding(16)
        .frame(width: 380)
    }

    private func open(_ route: Route?) {
        if let route { store.route = route }
        openWindow(id: VigieApp.mainWindowID)
        NSApplication.shared.activate()
    }
}

/// Chaque compte : pastille verte s'il consomme, ce qui tourne dessus, débit, session et semaine.
struct PanelAccounts: View {
    @Environment(VigieStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(store.accounts) { account in
                let working = store.working(on: account.id)
                let rate = store.ratePerHour(on: account.id)
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Circle()
                        .fill(working.isEmpty ? AnyShapeStyle(.quaternary) : AnyShapeStyle(Theme.live))
                        .frame(width: 7, height: 7)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(account.displayName)
                            .font(.callout.weight(.medium))
                        Text(account.isConnected ? (working.isEmpty ? "Rien ne tourne" : working.map(\.shortTitle).joined(separator: " · "))
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
                                .foregroundStyle(Theme.live)
                                .monospacedDigit()
                        }
                        VStack(alignment: .trailing, spacing: 1) {
                            usage("Session", account.usage?.session)
                            usage("Semaine", account.usage?.week)
                        }
                        .font(.caption)
                    }
                }
                .opacity(account.isConnected ? 1 : Theme.dim)
            }
        }
    }

    private func usage(_ title: String, _ window: UsageWindow?) -> some View {
        HStack(spacing: 3) {
            Text(title).foregroundStyle(.secondary)
            Text(window?.pct.map(Fmt.pct) ?? "—")
                .monospacedDigit()
                .foregroundStyle(window?.pct.map { $0 >= 80 ? AnyShapeStyle(Theme.gaugeTint($0)) : AnyShapeStyle(.primary) } ?? AnyShapeStyle(.secondary))
        }
        .help(window?.resetsAt.map { "\(title) : remise à zéro \(Fmt.reset($0, now: store.now))" } ?? title)
    }
}

struct PanelReviewRow: View {
    let item: ReviewItem

    var body: some View {
        HStack(spacing: 8) {
            RowIcon(symbol: Theme.symbol(for: item.reviewKind), alert: Theme.isAlert(item.reviewKind))
            VStack(alignment: .leading, spacing: 0) {
                Text(item.reviewKind == .question ? "« \(item.title ?? "") »" : item.title ?? "")
                    .font(.callout)
                    .lineLimit(1)
                Text([item.conversationTitle, item.detail].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .contentShape(.rect)
    }
}
