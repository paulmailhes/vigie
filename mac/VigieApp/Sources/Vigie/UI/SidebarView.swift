import AppKit
import SwiftUI

/// Barre latérale (verre automatique) : Vue d'ensemble, Conversations, Comptes, puis les outils (MCP, Agents,
/// Historique, En fond).
struct SidebarView: View {
    @Environment(VigieStore.self) private var store
    @State private var showClosed = false
    /// Mode captures : copie de la barre latérale rendue hors du verre ; elle n'écrit pas la sélection.
    var standIn = false

    var body: some View {
        @Bindable var store = store
        List(selection: standIn ? .constant(nil) : $store.route) {
            Section {
                HStack {
                    SidebarLabel("Vue d'ensemble", symbol: "binoculars")
                    Spacer(minLength: 4)
                    OverviewCount()
                }
                .background { if !standIn { CalmSidebarSelection() } }
                .tag(Route.overview)
                .standInHighlight(standIn && store.route == .overview)
            }

            Section("Conversations") {
                ForEach(openConversations) { conversation in
                    SidebarConversationRow(conversation: conversation)
                        .tag(Route.conversation(conversation.id))
                        .standInHighlight(standIn && store.route == .conversation(conversation.id))
                }
                if openConversations.isEmpty && store.loadedOnce {
                    Text("Aucune conversation ouverte")
                        .foregroundStyle(.secondary)
                        .selectionDisabled()
                }
            }

            if !closedConversations.isEmpty {
                Section(isExpanded: $showClosed) {
                    ForEach(closedConversations) { conversation in
                        SidebarConversationRow(conversation: conversation)
                            .tag(Route.conversation(conversation.id))
                            .standInHighlight(standIn && store.route == .conversation(conversation.id))
                    }
                } header: {
                    // le nombre collé au titre (pas poussé à droite : la flèche de la section y apparaît au survol)
                    HStack(spacing: 4) {
                        Text("Fermées récemment")
                        Text(Fmt.int(closedConversations.count))
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                    .accessibilityElement(children: .combine)
                }
            }

            // Une entrée par compte : le clic ouvre la page Comptes sur ce compte ; leur aperçu reste visible ici.
            Section("Comptes") {
                ForEach(store.accounts) { account in
                    SidebarAccountRow(account: account)
                        .tag(Route.account(account.id))
                        .standInHighlight(standIn && store.route == .account(account.id))
                }
            }

            Section("Outils") {
                SidebarLabel("MCP", symbol: "puzzlepiece.extension")
                    .tag(Route.mcp)
                    .standInHighlight(standIn && store.route == .mcp)
                SidebarLabel("Agents", symbol: Icon.recipe)
                    .tag(Route.agents)
                    .standInHighlight(standIn && store.route == .agents)
                SidebarLabel("Historique", symbol: "clock.arrow.circlepath")
                    .tag(Route.history)
                    .standInHighlight(standIn && store.route == .history)
                HStack {
                    SidebarLabel("En fond", symbol: "memorychip")
                    Spacer(minLength: 4)
                    if store.forgottenCount > 0 {
                        CountBadge(count: store.forgottenCount, warn: true)
                            .help("Oubliés : leur conversation est fermée")
                    }
                }
                .tag(Route.background)
                .standInHighlight(standIn && store.route == .background)
            }
        }
        .listStyle(.sidebar)
        .navigationSplitViewColumnWidth(min: 230, ideal: 270, max: 360)
    }

    private var openConversations: [ConversationSummary] {
        store.conversations.filter(\.isOpen)
    }

    private var closedConversations: [ConversationSummary] {
        store.conversations.filter { !$0.isOpen }
    }
}

/// Libellé de la barre latérale avec une icône monochrome (pas teintée par l'accent).
struct SidebarLabel: View {
    let title: String
    let symbol: String

    init(_ title: String, symbol: String) {
        self.title = title
        self.symbol = symbol
    }

    var body: some View {
        Label {
            Text(title)
        } icon: {
            Image(systemName: symbol)
                .foregroundStyle(.secondary)
        }
    }
}

/// Le chiffre de « Vue d'ensemble » : la pastille rouge des décisions qui t'attendent (`decisionCount`, le même que
/// l'icône et le panneau de la barre des menus) ; sans décision, le nombre de choses à regarder, en gris.
struct OverviewCount: View {
    @Environment(VigieStore.self) private var store

    var body: some View {
        let decisions = store.decisionCount
        if decisions > 0 {
            CountBadge(count: decisions, urgent: true)
                .help(decisions > 1 ? "\(decisions) décisions t'attendent" : "Une décision t'attend")
        } else {
            let look = store.lookItems(for: nil).count
            if look > 0 {
                CountBadge(count: look, label: "\(look) à regarder")
                    .help("À regarder : ce qui a mal tourné ou que tu dois faire toi-même")
            }
        }
    }
}

/// Une ligne : pastille d'état, nom, puis le compte sur lequel elle tourne et la pastille rouge de ce qui t'attend.
/// Une conversation fermée garde un nom lisible (`.secondary`) ; seule sa pastille est atténuée.
struct SidebarConversationRow: View {
    @Environment(VigieStore.self) private var store
    let conversation: ConversationSummary

    var body: some View {
        HStack(spacing: 8) {
            StatusDot(status: conversation.state)
                .opacity(conversation.isOpen ? 1 : Theme.dim)
            Text(conversation.shortTitle)
                .lineLimit(1)
                .foregroundStyle(conversation.isOpen ? .primary : .secondary)
                .layoutPriority(1)
            Spacer(minLength: 4)
            ConversationTrail(conversation: conversation)
        }
        .padding(.vertical, 2)
        .help(conversation.title ?? conversation.shortTitle)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(ConversationTrail.spoken(conversation, store: store))
    }
}

/// La fin de ligne d'une conversation, la même dans la barre latérale et dans la barre des menus : le compte sur
/// lequel elle tourne (toujours visible), puis la pastille rouge de ce qui t'attend (le calcul du badge rouge),
/// seulement s'il y a quelque chose.
struct ConversationTrail: View {
    @Environment(VigieStore.self) private var store
    let conversation: ConversationSummary
    /// Largeur fixe de la colonne du compte (barre des menus : les noms s'alignent) ; sinon, sa largeur.
    var accountWidth: CGFloat? = nil

    var body: some View {
        let decisions = store.decisionCount(for: conversation.id)
        let account = conversation.isOpen ? store.accountName(of: conversation) : ""
        HStack(spacing: 6) {
            if !account.isEmpty || accountWidth != nil {
                Text(account)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .frame(width: accountWidth, alignment: .trailing)
            }
            if decisions > 0 {
                CountBadge(count: decisions, urgent: true)
                    .fixedSize()
            }
        }
    }

    /// Ce que VoiceOver lit pour la ligne : « Atelier, À autoriser, Travail 1, 2 à décider ».
    static func spoken(_ conversation: ConversationSummary, store: VigieStore) -> String {
        let decisions = store.decisionCount(for: conversation.id)
        return [conversation.shortTitle, Theme.label(for: conversation.state),
                conversation.isOpen ? store.accountName(of: conversation) : "",
                decisions > 0 ? "\(decisions) à décider" : ""]
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
    }
}

/// Un compte : pastille verte quand une conversation consomme dessus (triangle rouge : connecté à la mauvaise
/// adresse), puis la limite qui compte (`AccountGauge`) : « sem. 39 % » et sa jauge, ou « Session pleine · 03:40 » en
/// rouge à la place de la jauge. Pas connecté : le nom en gris lisible, seule la pastille est atténuée.
struct SidebarAccountRow: View {
    @Environment(VigieStore.self) private var store
    let account: Account

    var body: some View {
        let gauge = AccountGauge(usage: account.usage, now: store.now)
        HStack(spacing: 8) {
            Group {
                if account.wrongAccount == true {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundStyle(Theme.alert)
                } else {
                    Circle()
                        .fill(store.working(on: account.id).isEmpty ? AnyShapeStyle(.quaternary) : AnyShapeStyle(Theme.live))
                        .frame(width: 8, height: 8)
                }
            }
            .frame(width: 18)
            .opacity(account.isConnected ? 1 : Theme.dim)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    Text(account.displayName)
                        .lineLimit(1)
                        .foregroundStyle(account.isConnected ? .primary : .secondary)
                    Spacer(minLength: 4)
                    if account.isConnected {
                        Text(gauge.label)
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(gauge.warn ? AnyShapeStyle(Theme.warnText) : AnyShapeStyle(.secondary))
                            .fixedSize()
                    }
                }
                if !account.isConnected {
                    Text("Pas connecté")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if let full = gauge.full {
                    Text(full)
                        .font(.caption.weight(.medium))
                        .monospacedDigit()
                        .foregroundStyle(Theme.alertText)
                        .lineLimit(1)
                } else {
                    UsageBar(pct: gauge.pct, height: 3)
                }
            }
        }
        .padding(.vertical, 2)
        .help(help(gauge))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(account.isConnected ? "\(account.displayName), \(gauge.help)" : "\(account.displayName), pas connecté")
    }

    private func help(_ gauge: AccountGauge) -> String {
        guard account.isConnected else { return "\(account.displayName) : pas connecté" }
        let working = store.working(on: account.id)
        let head = working.isEmpty ? account.displayName
            : "\(account.displayName) · consomme : " + working.map(\.shortTitle).joined(separator: ", ")
        return gauge.help.isEmpty ? head : head + "\n" + gauge.help
    }
}

/// La limite d'un compte qui compte le plus, la même dans la barre latérale et la barre des menus : la semaine
/// d'habitude ; la session quand elle passe 90 % (le seuil des alertes) et dépasse la semaine ; une fenêtre pleine
/// s'écrit en toutes lettres, en rouge (« Session pleine · 03:40 »).
struct AccountGauge: Equatable {
    /// Texte court à côté du nom : « sem. 39 % », « session 92 % ».
    let label: String
    /// La session passe 90 % sans être pleine : le texte court en orange.
    let warn: Bool
    /// Le pourcentage de la jauge (la fenêtre qui compte).
    let pct: Double?
    /// Une fenêtre pleine : ce texte rouge remplace la jauge (« Session pleine · 03:40 », « Semaine pleine »).
    let full: String?
    /// Les deux chiffres et leurs remises à zéro, pour l'aide au survol et VoiceOver.
    let help: String

    /// Seuil à partir duquel la session passe devant la semaine (celui des alertes de consommation).
    static let sessionAlert: Double = 90

    init(usage: AccountUsage?, now: Date) {
        let session = usage?.session, week = usage?.week
        let sessionPct = session?.pct, weekPct = week?.pct
        let weekLabel = "sem. \(Fmt.pct(weekPct))"
        if let weekPct, weekPct >= 100 {
            label = weekLabel
            warn = false
            pct = weekPct
            full = Self.fullText(week, session: false)
        } else if let sessionPct, sessionPct >= 100 {
            label = weekLabel
            warn = false
            pct = sessionPct
            full = Self.fullText(session, session: true)
        } else if let sessionPct, sessionPct >= Self.sessionAlert, sessionPct > (weekPct ?? 0) {
            label = "session \(Fmt.pct(sessionPct))"
            warn = true
            pct = sessionPct
            full = nil
        } else {
            label = weekLabel
            warn = false
            pct = weekPct
            full = nil
        }
        help = [Self.describe("Session", session, now: now), Self.describe("Semaine", week, now: now)]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    /// « Session pleine · 03:40 » (la session se remet à zéro dans les 5 h : l'heure suffit), « Semaine pleine » ; nil
    /// si la fenêtre n'est pas pleine.
    static func fullText(_ window: UsageWindow?, session: Bool) -> String? {
        guard let pct = window?.pct, pct >= 100 else { return nil }
        guard session else { return "Semaine pleine" }
        return window?.resetsAt.map { "Session pleine · \(Fmt.time($0))" } ?? "Session pleine"
    }

    /// « Session 100 %, remise à zéro aujourd'hui à 03:40 » ; nil sans relevé.
    static func describe(_ title: String, _ window: UsageWindow?, now: Date) -> String? {
        guard let pct = window?.pct else { return nil }
        guard let reset = window?.resetsAt else { return "\(title) \(Fmt.pct(pct))" }
        return "\(title) \(Fmt.pct(pct)), remise à zéro \(Fmt.reset(reset, now: now))"
    }
}

/// La barre latérale ne prend pas le focus clavier : sa sélection reste la sélection système discrète
/// (grise), au lieu d'un bloc plein de la couleur d'accent. Le clic sélectionne toujours normalement ;
/// pour le clavier : ⌘1 à ⌘6 (les pages), ⌥⌘1 à ⌥⌘9 (les conversations ouvertes), ⌘J, ⌘[ ⌘] et le menu Aller.
struct CalmSidebarSelection: NSViewRepresentable {
    func makeNSView(context: Context) -> Probe { Probe() }

    func updateNSView(_ view: Probe, context: Context) {
        view.apply()
    }

    final class Probe: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            apply()
            // La rangée peut être posée dans la table juste après : on réessaie au tour suivant.
            Task { @MainActor [weak self] in self?.apply() }
        }

        func apply() {
            var view = superview
            while let current = view {
                if let table = current as? NSTableView {
                    if !table.refusesFirstResponder { table.refusesFirstResponder = true }
                    if let window = table.window, window.firstResponder === table {
                        window.makeFirstResponder(nil)
                    }
                    return
                }
                view = current.superview
            }
        }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}

extension View {
    /// Sélection dessinée à la main pour la copie de la barre latérale (mode captures).
    func standInHighlight(_ on: Bool) -> some View {
        background {
            if on {
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color.primary.opacity(0.08))
                    .padding(.horizontal, -8)
                    .padding(.vertical, -3)
            }
        }
    }
}
