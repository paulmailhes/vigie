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

/// Page de tableau de bord : défile, occupe la largeur du détail (le Form groupé se limite à ~700 pt).
struct Page<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                content
            }
            .frame(maxWidth: 1080, alignment: .leading)
            .padding(.horizontal, 28)
            .padding(.vertical, 20)
            .frame(maxWidth: .infinity)
        }
    }
}

/// Section groupée façon macOS (titre, puis lignes séparées par un trait dans un cadre arrondi).
struct CardSection<Header: View, Content: View>: View {
    var header: Header
    @ViewBuilder var content: Content

    init(@ViewBuilder content: () -> Content, @ViewBuilder header: () -> Header) {
        self.content = content()
        self.header = header()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
                .font(.headline)
                .padding(.horizontal, 6)
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

extension CardSection where Header == Text {
    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.init(content: content) { Text(title) }
    }
}
