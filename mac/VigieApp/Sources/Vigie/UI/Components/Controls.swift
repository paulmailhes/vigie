import SwiftUI

// Les contrôles partagés : un seul habillage par rôle de bouton.
// - Action principale d'une zone : `.glassButton(.primary)` (une seule par zone). Secondaire : `.glassButton()`.
//   Lien dans une phrase : `.buttonStyle(.link)`.
// - Icône seule : `IconButton` (28×28 pt au moins, libellé obligatoire). Seulement pour une action sans risque
//   (Fermer, Retirer, Actualiser = toujours `arrow.clockwise`), jamais pour une décision.
// - Plus d'actions : `MoreMenu(name:)`.
// - Une décision : `DecisionButtons` (« Voir · Refuser · Autoriser », en mots, dans cet ordre).
// - Une tuile, une bulle ou une rangée qui ouvre un détail : `.buttonStyle(TileButtonStyle())` ; une puce
//   cliquable : `ChipButtonStyle` (déjà posé par `Chip(action:)`). Le `.plain` reste pour ce qui a déjà son cadre
//   (options d'une feuille) et pour les bascules.
// - Taille : `.regular` dans les pages, `.controlSize(.small)` dans les rangées de liste et la tuile d'état.

/// Une tuile, une bulle de l'Échange ou une rangée qui ouvre un panneau : fond léger au survol, plus marqué pendant
/// l'appui, curseur main. Pas de rétrécissement à l'appui (les contrôles de macOS ne rétrécissent pas).
///
///     Button { open(.agent(agent.id)) } label: { … }
///         .buttonStyle(TileButtonStyle())
struct TileButtonStyle: ButtonStyle {
    /// Rayon du fond de survol : celui de la tuile cliquée (`Theme.corner` pour une tuile posée sur la page).
    var cornerRadius: CGFloat = Theme.cornerInner

    func makeBody(configuration: Configuration) -> some View {
        PressableBody(configuration: configuration, shape: RoundedRectangle(cornerRadius: cornerRadius), pointer: true)
    }
}

/// Une puce qui ouvre un détail : le même retour que `TileButtonStyle`, sur une capsule.
struct ChipButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        PressableBody(configuration: configuration, shape: Capsule(), pointer: true)
    }
}

/// Bouton icône discret (Fermer, Retirer) : icône `.secondary`, fond léger au survol, sans curseur main.
struct IconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        PressableBody(configuration: configuration, shape: RoundedRectangle(cornerRadius: Theme.cornerInner), pointer: false)
            .foregroundStyle(.secondary)
    }
}

/// Le corps commun des styles de survol : une petite vue, pour porter l'état de survol (un `ButtonStyle` n'a pas
/// d'état). Le fond passe par-dessus (`overlay`), pour se voir aussi sur un contenu qui a déjà son propre fond.
private struct PressableBody<S: Shape>: View {
    let configuration: ButtonStyleConfiguration
    let shape: S
    let pointer: Bool
    @State private var hovering = false
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        configuration.label
            .contentShape(shape)
            .overlay {
                shape
                    .fill(Color.primary.opacity(configuration.isPressed ? 0.12 : 0.06))
                    .opacity(enabled && (hovering || configuration.isPressed) ? 1 : 0)
                    .allowsHitTesting(false)
            }
            .opacity(configuration.isPressed ? 0.85 : 1)
            .onHover { hovering = $0 }
            .pointerStyle(pointer && enabled ? .link : nil)
            .animation(.snappy(duration: 0.15), value: configuration.isPressed)
            .animation(.snappy(duration: 0.15), value: hovering)
    }
}

/// Bouton icône seule : 28×28 pt au moins (on ne le rate pas au trackpad), libellé obligatoire, lu par VoiceOver et
/// montré au survol. Seulement pour une action sans risque, jamais pour autoriser ou refuser. Il attend la fin d'une
/// action asynchrone (roue à sa place, pas de second clic).
///
///     IconButton("Fermer", systemImage: "xmark", help: "Fermer (Échap)") { store.conversationPanel = nil }
///     IconButton("Retirer", systemImage: "xmark") { await store.dismissReview(item) }
///     IconButton("Actualiser", systemImage: "arrow.clockwise", look: .glass) { await store.refreshUsage(nil) }
struct IconButton: View {
    enum Look: Sendable {
        /// Discret : icône grise, fond au survol (Fermer un panneau, Retirer une info).
        case plain
        /// Bouton en verre, à côté d'autres boutons en verre (barre d'une page).
        case glass
    }

    let label: String
    let systemImage: String
    var role: ButtonRole? = nil
    var look: Look = .plain
    var help: String? = nil
    let action: @MainActor () async -> Void

    init(_ label: String, systemImage: String, role: ButtonRole? = nil, look: Look = .plain, help: String? = nil,
         action: @escaping @MainActor () async -> Void) {
        self.label = label
        self.systemImage = systemImage
        self.role = role
        self.look = look
        self.help = help
        self.action = action
    }

    var body: some View {
        switch look {
        case .plain:
            AsyncButton(role: role, action: action) {
                Label(label, systemImage: systemImage)
                    .labelStyle(.iconOnly)
                    .frame(minWidth: 28, minHeight: 28)
                    .contentShape(.rect)
            }
            .buttonStyle(IconButtonStyle())
            .accessibilityLabel(label)
            .help(help ?? label)
        case .glass:
            AsyncButton(role: role, action: action) {
                Label(label, systemImage: systemImage)
                    .labelStyle(.iconOnly)
                    .frame(minWidth: 16, minHeight: 16)
            }
            .glassButton()
            .accessibilityLabel(label)
            .help(help ?? label)
        }
    }
}

/// Menu « … » d'une rangée ou d'une carte : toujours la même taille (28 pt), à la même place, avec un vrai libellé
/// VoiceOver (« Plus d'actions pour Atelier »).
///
///     MoreMenu(name: account.displayName) {
///         Button("Renommer…") { … }
///         Button("Supprimer de Vigie…", role: .destructive) { … }
///     }
struct MoreMenu<Content: View>: View {
    /// Le nom de ce que le menu concerne, pour VoiceOver.
    let name: String
    @ViewBuilder var content: () -> Content

    init(name: String, @ViewBuilder content: @escaping () -> Content) {
        self.name = name
        self.content = content
    }

    var body: some View {
        Menu {
            content()
        } label: {
            Label("Plus d'actions pour \(name)", systemImage: "ellipsis")
                .labelStyle(.iconOnly)
                .frame(width: 28, height: 28)
                .contentShape(.rect)
        }
        .menuStyle(.button)
        .buttonStyle(.borderless)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Plus d'actions")
        .accessibilityLabel("Plus d'actions pour \(name)")
    }
}

/// Les boutons d'une décision, les mêmes partout : « Voir · Refuser · Autoriser », en mots, dans cet ordre.
/// « Autoriser » est l'action principale (bleu) ; « une fois » ne s'écrit que dans l'aide et dans la fiche. Aucun
/// raccourci clavier (jamais d'autorisation au clavier), jamais de croix seule pour refuser. Les boutons ne se coupent
/// pas (`fixedSize`) : la rangée qui les porte doit passer les boutons sous le texte quand la place manque
/// (`ViewThatFits`).
///
///     DecisionButtons(see: { store.blockedRequest = item }, allowHelp: "Autoriser une fois : git push") {
///         _ = await store.decidePending(item, allow: false)
///     } allow: {
///         _ = await store.decidePending(item, allow: true)
///     }
struct DecisionButtons: View {
    /// « Voir… » (la fiche, dans Vigie) ; nil quand on y est déjà.
    var see: (() -> Void)?
    var seeHelp: String
    var allowHelp: String
    let refuse: @MainActor () async -> Void
    let allow: @MainActor () async -> Void

    init(see: (() -> Void)? = nil, seeHelp: String = "Voir l'action en entier", allowHelp: String = "Autoriser une fois",
         refuse: @escaping @MainActor () async -> Void, allow: @escaping @MainActor () async -> Void) {
        self.see = see
        self.seeHelp = seeHelp
        self.allowHelp = allowHelp
        self.refuse = refuse
        self.allow = allow
    }

    var body: some View {
        HStack(spacing: 6) {
            if let see {
                Button("Voir", action: see)
                    .glassButton()
                    .help(seeHelp)
            }
            AsyncButton("Refuser", action: refuse)
                .glassButton()
                .help("Refuser cette fois : Claude ne la fait pas")
            AsyncButton("Autoriser", action: allow)
                .glassButton(.primary)
                .help(allowHelp)
        }
        .fixedSize()
    }
}

/// `DecisionButtons` branchés sur une action sensible de « À décider » : décide d'ici (VS Code ou Codex, selon
/// l'élément), « Voir » ouvre sa fiche. Rien de plus à écrire dans un écran.
///
///     ReviewDecisionButtons(item: item)
///     ReviewDecisionButtons(item: item, showSee: false)   // dans la fiche elle-même
struct ReviewDecisionButtons: View {
    @Environment(VigieStore.self) private var store
    let item: ReviewItem
    var showSee = true

    var body: some View {
        let what = item.command ?? item.title ?? ""
        DecisionButtons(see: showSee ? { store.blockedRequest = item } : nil,
                        seeHelp: "La commande en entier",
                        allowHelp: what.isEmpty ? "Autoriser une fois" : "Autoriser une fois : \(what)") {
            if item.isAwaitingApproval { _ = await store.decideApproval(item, allow: false) }
            else { _ = await store.decidePending(item, allow: false) }
        } allow: {
            if item.isAwaitingApproval { _ = await store.decideApproval(item, allow: true) }
            else { _ = await store.decidePending(item, allow: true) }
        }
    }
}
