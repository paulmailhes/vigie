import AppKit
import SwiftUI

/// Barre latérale (verre automatique) : Vue d'ensemble, Conversations, Comptes, puis les outils (MCP, Agents,
/// Historique).
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
                    if store.toReviewCount > 0 {
                        CountBadge(count: store.toReviewCount, urgent: store.somethingWaits)
                    }
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
                Section("Fermées récemment", isExpanded: $showClosed) {
                    ForEach(closedConversations) { conversation in
                        SidebarConversationRow(conversation: conversation)
                            .tag(Route.conversation(conversation.id))
                            .standInHighlight(standIn && store.route == .conversation(conversation.id))
                    }
                }
            }

            // Une seule entrée : tous les comptes sont sur la même page ; leur aperçu reste visible ici.
            Section("Comptes") {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(store.accounts) { account in
                        SidebarAccountRow(account: account)
                    }
                }
                .tag(Route.account(accountsRouteID))
                .standInHighlight(standIn && store.route == .account(accountsRouteID))
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
            }
        }
        .listStyle(.sidebar)
        .navigationSplitViewColumnWidth(min: 230, ideal: 270, max: 360)
    }

    /// La page Comptes, quel que soit le compte d'où l'on vient.
    private var accountsRouteID: String {
        if case .account(let id) = store.route { return id }
        return store.accounts.first?.id ?? "principal"
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

/// Une ligne : pastille d'état, nom, compte sur lequel elle tourne ; un compteur rouge si elle t'attend.
struct SidebarConversationRow: View {
    @Environment(VigieStore.self) private var store
    let conversation: ConversationSummary

    var body: some View {
        HStack(spacing: 8) {
            StatusDot(status: conversation.state)
            Text(conversation.shortTitle)
                .lineLimit(1)
            Spacer(minLength: 4)
            let waiting = store.urgentItems(for: conversation.id).count
            if waiting > 0 {
                CountBadge(count: waiting, urgent: true)
            } else if conversation.isOpen {
                Text(accountName)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
        .opacity(conversation.isOpen ? 1 : Theme.dim)
        .help(conversation.title ?? conversation.shortTitle)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(conversation.shortTitle), \(Theme.label(for: conversation.state)), \(accountName)")
    }

    private var accountName: String {
        let id = conversation.resume?.to ?? store.runningAccountId(of: conversation)
        return store.account(id)?.displayName ?? id ?? ""
    }
}

/// Un compte : pastille verte quand une conversation consomme dessus, jauge de la semaine ;
/// atténué s'il n'est pas connecté.
struct SidebarAccountRow: View {
    @Environment(VigieStore.self) private var store
    let account: Account

    var body: some View {
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
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    Text(account.displayName)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(weekText)
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                if account.isConnected {
                    UsageBar(pct: account.usage?.week?.pct, height: 3)
                } else {
                    Text("Pas connecté")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
        .opacity(account.isConnected ? 1 : Theme.dim)
        .help(store.working(on: account.id).isEmpty ? account.displayName
              : "Consomme : " + store.working(on: account.id).map(\.shortTitle).joined(separator: ", "))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(account.displayName), semaine \(weekText)")
    }

    private var weekText: String {
        guard account.isConnected else { return "" }
        return account.usage?.week?.pct.map(Fmt.pct) ?? "—"
    }
}

extension VigieStore {
    /// Quelque chose t'attend vraiment (action bloquée, conversation en attente) : seul cas en rouge.
    var somethingWaits: Bool {
        toReview.contains { Theme.isAlert($0.reviewKind) }
    }
}

/// La barre latérale ne prend pas le focus clavier : sa sélection reste la sélection système discrète
/// (grise), au lieu d'un bloc plein de la couleur d'accent. Le clic sélectionne toujours normalement ;
/// ⌘1 à ⌘5 et le menu Aller restent pour le clavier.
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
