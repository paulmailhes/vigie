import SwiftUI

/// Largeurs des colonnes de droite, les mêmes dans toutes les rangées de la page (et d'une section à l'autre).
enum MCPColumns {
    /// « 12 345 appels en 7 j » en `.callout`.
    static let uses: CGFloat = 128
    /// Interrupteur et menu « … » (28 pt).
    static let controls: CGFloat = 78
}

/// Un état à régler, en puce à côté du nom (« en échec », « à connecter ») : la ligne et son geste sont dans la
/// section « À régler », en tête de la page.
struct MCPRowStatus: Equatable {
    let text: String
    let tone: Chip.Tone
}

/// Une rangée de MCP, la même partout : icône, nom (et sa puce d'état s'il y a quelque chose à régler) et provenance à
/// gauche (une ligne chacun, jamais coupés en deux) ; à droite des colonnes de largeur fixe (utilisations,
/// interrupteur, menu) alignées d'une rangée à l'autre ; en dessous, seulement s'il y a quelque chose à voir, des
/// lignes d'état avec leur geste.
struct MCPRowLayout<Controls: View, Details: View>: View {
    let service: String?
    let name: String
    let subtitle: String
    var dimmed = false
    var status: MCPRowStatus? = nil
    var uses: Int?
    @ViewBuilder var controls: () -> Controls
    @ViewBuilder var details: () -> Details

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            ServiceGlyph(service: service, name: name)
                .opacity(dimmed ? Theme.dim : 1)
                .padding(.top, 3)
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(name)
                                .textRole(.item)
                                .foregroundStyle(dimmed ? .secondary : .primary)
                                .lineLimit(1)
                                .truncationMode(.tail)
                            if let status {
                                Chip(status.text, tone: status.tone)
                            }
                        }
                        if !subtitle.isEmpty {
                            InfoLine(parts: [subtitle])
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    UsesLabel(count: uses)
                        .frame(width: MCPColumns.uses, alignment: .trailing)
                    HStack(spacing: 10) { controls() }
                        .frame(width: MCPColumns.controls, alignment: .trailing)
                }
                details()
            }
        }
        .padding(.vertical, 4)
    }
}

extension MCPRowLayout where Details == EmptyView {
    init(service: String?, name: String, subtitle: String, dimmed: Bool = false, status: MCPRowStatus? = nil, uses: Int?,
         @ViewBuilder controls: @escaping () -> Controls) {
        self.init(service: service, name: name, subtitle: subtitle, dimmed: dimmed, status: status, uses: uses,
                  controls: controls) { EmptyView() }
    }
}
