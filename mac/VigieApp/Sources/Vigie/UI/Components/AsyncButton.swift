import SwiftUI

/// Bouton qui attend le moteur : tant que l'action n'est pas finie, son libellé passe en grisé et une roue tourne
/// à sa place, là où l'utilisateur vient de cliquer (l'utilisateur : « je veux avoir du mouvement tant que ça
/// réfléchit »). Un second clic pendant ce temps ne relance rien. Rien d'autre à annoncer quand c'est fini :
/// la roue disparaît, l'écran montre le résultat ; seule une erreur affiche un message.
struct AsyncButton<Label: View>: View {
    private let role: ButtonRole?
    private let action: @MainActor () async -> Void
    private let label: Label
    @State private var running = false

    init(role: ButtonRole? = nil, action: @escaping @MainActor () async -> Void, @ViewBuilder label: () -> Label) {
        self.role = role
        self.action = action
        self.label = label()
    }

    var body: some View {
        Button(role: role) {
            guard !running else { return }
            running = true
            Task { @MainActor in
                await action()
                running = false
            }
        } label: {
            label
                .opacity(running ? 0.3 : 1)
                .overlay {
                    if running {
                        ProgressView()
                            .controlSize(.small)
                            .accessibilityLabel("En cours")
                    }
                }
                .animation(.smooth(duration: 0.15), value: running)
        }
        .allowsHitTesting(!running)
    }
}

extension AsyncButton where Label == Text {
    init(_ title: String, role: ButtonRole? = nil, action: @escaping @MainActor () async -> Void) {
        self.init(role: role, action: action) { Text(title) }
    }
}

extension AsyncButton where Label == SwiftUI.Label<Text, Image> {
    init(_ title: String, systemImage: String, role: ButtonRole? = nil, action: @escaping @MainActor () async -> Void) {
        self.init(role: role, action: action) { SwiftUI.Label(title, systemImage: systemImage) }
    }
}

/// Une roue à la place d'un libellé de menu pendant que l'action choisie dans ce menu s'exécute
/// (un menu se referme tout de suite : c'est son libellé qui montre que ça travaille).
struct BusyLabel<Content: View>: View {
    let busy: Bool
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .opacity(busy ? 0.3 : 1)
            .overlay { if busy { ProgressView().controlSize(.small) } }
            .animation(.smooth(duration: 0.15), value: busy)
    }
}
