import SwiftUI

/// Largeurs des colonnes de droite, les mêmes dans toutes les rangées de la page (et d'une section à l'autre).
enum MCPColumns {
    static let uses: CGFloat = 96
    static let controls: CGFloat = 78
}

/// Une rangée de MCP, la même partout : icône, nom et provenance à gauche (une ligne chacun, jamais coupés en deux) ;
/// à droite des colonnes de largeur fixe (utilisations, interrupteur, menu) alignées d'une rangée à l'autre ; en
/// dessous, seulement s'il y a quelque chose à voir ou à faire, des lignes d'état avec leur geste.
struct MCPRowLayout<Controls: View, Details: View>: View {
    let service: String?
    let name: String
    let subtitle: String
    var dimmed = false
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
                        Text(name)
                            .fontWeight(.medium)
                            .foregroundStyle(dimmed ? .secondary : .primary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        if !subtitle.isEmpty {
                            Text(subtitle)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
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
    init(service: String?, name: String, subtitle: String, dimmed: Bool = false, uses: Int?, @ViewBuilder controls: @escaping () -> Controls) {
        self.init(service: service, name: name, subtitle: subtitle, dimmed: dimmed, uses: uses, controls: controls) { EmptyView() }
    }
}

/// Bouton « … » des rangées : toujours la même taille, à la même place.
struct MCPMoreMenu<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        Menu {
            content()
        } label: {
            Label("Plus", systemImage: "ellipsis")
                .labelStyle(.iconOnly)
                .frame(width: 22, height: 22)
                .contentShape(.rect)
        }
        .menuStyle(.button)
        .buttonStyle(.borderless)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Plus d'actions")
    }
}
