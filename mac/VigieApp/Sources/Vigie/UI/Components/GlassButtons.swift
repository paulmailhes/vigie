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
    /// Ses cartes ne dépassent pas 704 pt, et le Form natif les pose à 20 pt des bords quand le détail est étroit
    /// (mesuré par un rendu hors écran à 690 et 1010 pt). `contentMargins(.scrollContent)` ajoute les 8 pt qui
    /// manquent pour tomber sur la marge des pages (28 pt, comme une `Page`) : il agit à l'intérieur de la vue qui
    /// défile (elle reste pleine largeur, sa barre au bord droit) et ne change rien quand les cartes sont centrées
    /// (fenêtre large). Rien ne les élargit au-delà de 704 pt : elles restent plus étroites que le contenu d'une `Page`
    /// (1080 pt), centrées comme lui. Seulement des largeurs maximales et une marge fixe : rien ne remonte vers la
    /// colonne de la fenêtre. Les Réglages (⌘,) et les feuilles gardent `.formStyle(.grouped)` tel quel.
    func pageForm() -> some View {
        formStyle(.grouped)
            .contentMargins(.horizontal, PageMetrics.margin - PageMetrics.formCardInset, for: .scrollContent)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
