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
    /// Formulaire groupé natif (sections arrondies, clair et sombre) pour les pages d'outils de la fenêtre (Comptes,
    /// MCP, Agents). Le Form défile lui-même : il occupe toute la largeur du détail, pour que sa barre de défilement
    /// reste collée au bord droit de la fenêtre, et il centre ses cartes de lui-même.
    /// Ses cartes ne dépassent pas 704 pt, à 20 pt au moins des bords (mesuré par un rendu hors écran à 1010 pt) :
    /// aucun réglage public ne les élargit (`contentMargins`, `safeAreaPadding`, `controlSize` n'y changent rien), et
    /// un retrait posé autour du Form écarterait sa barre de défilement du bord. Elles restent donc plus étroites que
    /// le contenu d'une `Page` (1080 pt), centrées comme lui. Seulement des largeurs maximales : rien ne remonte vers
    /// la colonne de la fenêtre. Les Réglages (⌘,) et les feuilles gardent `.formStyle(.grouped)` tel quel.
    func pageForm() -> some View {
        formStyle(.grouped)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
