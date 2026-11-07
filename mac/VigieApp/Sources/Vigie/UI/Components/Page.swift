import SwiftUI

extension View {
    /// Une colonne de la fenêtre (page, détail ouvert à droite) : sa taille minimale est une constante, jamais tirée de
    /// son contenu. AppKit redemande cette taille à chaque passe de mise en page : si elle dépend de la largeur (mise
    /// en page adaptable, ViewThatFits, tuiles en colonnes), la colonne et le séparateur se renvoient la balle sans
    /// fin, et l'app plante (« more Update Constraints in Window passes than there are views »). Le contenu s'adapte
    /// à l'intérieur. À poser sur toute vue qui entre dans un `.inspector` ou une colonne : essai `VIGIE_STRESS=1`.
    func splitColumn(minWidth: CGFloat = 0) -> some View {
        frame(minWidth: minWidth, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// Le gabarit commun des pages de la fenêtre : toutes ont le même bord gauche. `Page` pour les tableaux de bord ;
/// `Form` aligné à gauche pour les pages d'outils (Comptes, MCP, Agents) ; l'Historique (table et panneau) à part.
/// Constantes hors de toute vue : utilisables dans une fermeture `Sendable` (`onGeometryChange`).
enum PageMetrics {
    /// Marge à gauche et à droite du contenu d'une page.
    static let margin: CGFloat = 28
    /// Marge en haut et en bas.
    static let verticalMargin: CGFloat = 20
    /// Largeur maximale du contenu (au-delà, le contenu se centre dans la fenêtre).
    static let maxWidth: CGFloat = 1080
    /// Entre deux sections d'une page.
    static let sectionSpacing: CGFloat = 24
    /// Retrait d'un `SectionHeader` dans l'en-tête d'une Section de Form (MCP, Agents) : l'en-tête natif ajoute 4 pt,
    /// retirés ici pour que le titre tombe au même bord que ceux d'une `Page` (6 pt du bord de la carte).
    static let formHeaderInset: CGFloat = -4
}

/// Page de tableau de bord : défile, occupe la largeur du détail (le Form groupé se limite à ~700 pt).
struct Page<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PageMetrics.sectionSpacing) {
                content
            }
            .frame(maxWidth: PageMetrics.maxWidth, alignment: .leading)
            .padding(.horizontal, PageMetrics.margin)
            .padding(.vertical, PageMetrics.verticalMargin)
            .frame(maxWidth: .infinity)
        }
    }
}

/// Section groupée façon macOS : un titre de section (`SectionHeader`, hors de la carte), puis des lignes séparées par
/// un trait dans un cadre arrondi.
///
///     CardSection("Conversations", count: 4) { rows }
///     CardSection("À décider", count: 3, urgent: true) { rows }
///     CardSection("Apps ouvertes par un agent", note: "Tu peux les vouloir.") { rows } trailing: { Button(…) }
///
/// L'ancienne forme à en-tête libre (`CardSection { rows } header: { … }`) reste compilable le temps de la migration :
/// elle pose alors elle-même la police `.headline` et le retrait de 6 pt du titre. Avec un `SectionHeader`, c'est lui
/// qui les porte (jamais deux fois).
struct CardSection<Header: View, Content: View>: View {
    private var header: Header
    /// En-tête libre (ancienne forme) : la police et le retrait du titre de section lui sont posés ici.
    private var styleHeader: Bool
    @ViewBuilder var content: Content

    /// Ancienne forme, en-tête libre : à remplacer par `CardSection(title, count:, urgent:, note:)`.
    init(@ViewBuilder content: () -> Content, @ViewBuilder header: () -> Header) {
        self.content = content()
        self.header = header()
        self.styleHeader = true
    }

    /// Titre de section standard, avec une action à droite.
    init<Trailing: View>(_ title: String, count: Int? = nil, urgent: Bool = false, note: String? = nil,
                         @ViewBuilder content: () -> Content, @ViewBuilder trailing: () -> Trailing)
    where Header == SectionHeader<Trailing> {
        self.content = content()
        self.header = SectionHeader(title, count: count, urgent: urgent, note: note, trailing: trailing)
        self.styleHeader = false
    }

    /// Titre de section standard.
    init(_ title: String, count: Int? = nil, urgent: Bool = false, note: String? = nil,
         @ViewBuilder content: () -> Content) where Header == SectionHeader<EmptyView> {
        self.content = content()
        self.header = SectionHeader(title, count: count, urgent: urgent, note: note)
        self.styleHeader = false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if styleHeader {
                header
                    .font(.headline)
                    .padding(.horizontal, 6)
            } else {
                header
            }
            VStack(alignment: .leading, spacing: 0) {
                Group(subviews: content) { rows in
                    ForEach(rows) { row in
                        row
                            .padding(.horizontal, 14)
                            .padding(.vertical, 9)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if row.id != rows.last?.id {
                            Divider()
                                .padding(.leading, 14)
                        }
                    }
                }
            }
            .padding(.vertical, 3)
            .background(.quinary, in: .rect(cornerRadius: Theme.corner))
        }
    }
}
