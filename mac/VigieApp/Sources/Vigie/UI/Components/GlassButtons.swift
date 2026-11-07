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
    /// MCP, Agents), calé à gauche : ses cartes commencent au même bord que celles de `Page` (28 pt du bord).
    /// Le Form groupé centre ses cartes et les limite à 704 pt, avec 20 pt de retrait de chaque côté (mesuré par un
    /// rendu hors écran) : on le limite à 704 + 2 × 20 pt pour qu'il ne centre plus rien, puis on ajoute 8 pt pour
    /// tomber sur 28. Seulement des largeurs maximales : rien ne remonte vers la colonne de la fenêtre. Les Réglages
    /// (⌘,) et les feuilles gardent `.formStyle(.grouped)` tel quel.
    func pageForm() -> some View {
        let cardWidth: CGFloat = 704   // largeur maximale d'une carte du Form groupé
        let formInset: CGFloat = 20    // retrait du Form entre son bord et ses cartes
        return formStyle(.grouped)
            .frame(maxWidth: cardWidth + 2 * formInset)
            .padding(.horizontal, PageMetrics.margin - formInset)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
