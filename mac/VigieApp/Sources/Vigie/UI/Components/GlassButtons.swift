import SwiftUI

/// Boutons Liquid Glass : `.glassProminent` pour l'action principale d'un écran, `.glass` pour les autres.
///
/// En mode captures (--snapshot), le rendu passe par `cacheDisplay`, qui ne sait pas dessiner le verre
/// (une ligne contenant un bouton en verre disparaît entière). Les captures utilisent alors les styles
/// `bordered` équivalents ; l'app normale garde toujours le verre.
enum GlassRole {
    case primary
    case secondary
}

struct GlassButtonModifier: ViewModifier {
    let role: GlassRole

    func body(content: Content) -> some View {
        switch (role, SnapshotMode.isActive) {
        case (.primary, false): content.buttonStyle(.glassProminent)
        case (.secondary, false): content.buttonStyle(.glass)
        case (.primary, true): content.buttonStyle(.borderedProminent)
        case (.secondary, true): content.buttonStyle(.bordered)
        }
    }
}

extension View {
    func glassButton(_ role: GlassRole = .secondary) -> some View {
        modifier(GlassButtonModifier(role: role))
    }
}

enum SnapshotMode {
    /// Constant pour toute la vie du processus : aucune bascule d'identité des vues.
    static let isActive = LaunchOptions.current.isSnapshot
}

extension View {
    /// Formulaire groupé natif (sections arrondies, clair et sombre) pour les pages de réglages.
    func pageForm() -> some View {
        formStyle(.grouped)
    }
}
