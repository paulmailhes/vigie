import SwiftUI

/// Icône et texte serrés, icône centrée sur la première ligne.
struct CompactLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            configuration.icon
                .imageScale(.small)
                .frame(width: 14)
            configuration.title
        }
    }
}
