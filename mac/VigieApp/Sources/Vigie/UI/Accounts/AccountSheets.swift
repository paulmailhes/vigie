import SwiftUI

/// Grande icône monochrome en tête d'une feuille.
struct SheetIcon: View {
    let symbol: String

    var body: some View {
        Image(systemName: symbol)
            .symbolRenderingMode(.hierarchical)
            .font(.system(size: 26))
            .foregroundStyle(.secondary)
            .frame(width: 34, height: 34)
            .accessibilityHidden(true)
    }
}
