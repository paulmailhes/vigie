import SwiftUI

/// Puce : un état court à côté d'un titre (« À autoriser », « en échec », « refusée dans 8 min »), une info compacte
/// (« Journal 20 »), ou un raccourci qui ouvre un détail. Une seule puce dans toute l'app, pour qu'elle veuille dire
/// la même chose partout :
/// - neutre : fond `.quinary`, texte `.secondary` ;
/// - teintée (`live`, `warn`, `alert`, `you`) : fond de la couleur à 12 %, symbole et texte en couleur de TEXTE
///   (`Theme.…Text`, lisible en mode clair) ;
/// - `selected` : le seul cas plein, un filtre choisi (fond `Theme.action`, texte blanc) ;
/// - jamais de bordure. Sur une tuile déjà teintée (État rose ou orange), une puce neutre disparaît : `raised: true`
///   lui donne le fond posé `Theme.raised` ;
/// - cliquable (`action`) : `ChipButtonStyle` (survol, appui, curseur main) et un chevron à droite.
/// Une puce ne se coupe jamais (`fixedSize`) : dans une rangée, c'est le texte voisin qui cède, ou la rangée qui passe
/// à la ligne (`WrapLayout`, `ViewThatFits`).
///
///     Chip("À autoriser", symbol: Icon.guardRule, tone: .alert)
///     Chip("Journal 20", size: .regular) { open(.journal) }
struct Chip: View {
    enum Tone: Sendable {
        case neutral, live, warn, alert, you
        /// Filtre choisi (Historique) : plein, en bleu d'action.
        case selected
    }

    enum Size: Sendable {
        /// `.caption.weight(.medium)`, marge 8×4 : à côté d'un titre, dans une ligne.
        case small
        /// `.callout`, marge 10×5 : une rangée de puces qui ouvrent un détail (« Journal 20 · Fichiers 14 »).
        case regular
    }

    let text: String
    var symbol: String? = nil
    var tone: Tone = .neutral
    var size: Size = .small
    /// Sur une tuile teintée : fond posé (`Theme.raised`) au lieu du gris, qui disparaîtrait.
    var raised = false
    var action: (() -> Void)? = nil

    init(_ text: String, symbol: String? = nil, tone: Tone = .neutral, size: Size = .small, raised: Bool = false,
         action: (() -> Void)? = nil) {
        self.text = text
        self.symbol = symbol
        self.tone = tone
        self.size = size
        self.raised = raised
        self.action = action
    }

    var body: some View {
        if let action {
            Button(action: action) { face(chevron: true) }
                .buttonStyle(ChipButtonStyle())
                .fixedSize()
        } else {
            face(chevron: false)
                .fixedSize()
        }
    }

    private func face(chevron: Bool) -> some View {
        HStack(spacing: 4) {
            if let symbol {
                Image(systemName: symbol)
                    .imageScale(.small)
                    .accessibilityHidden(true)
            }
            Text(text)
            if chevron {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
        }
        .font(size == .small ? .caption.weight(.medium) : .callout)
        .monospacedDigit()
        .lineLimit(1)
        .foregroundStyle(foreground)
        .padding(.horizontal, size == .small ? 8 : 10)
        .padding(.vertical, size == .small ? 4 : 5)
        .background(background, in: .capsule)
        .contentShape(.capsule)
    }

    private var foreground: AnyShapeStyle {
        switch tone {
        case .neutral: AnyShapeStyle(.secondary)
        case .live: AnyShapeStyle(Theme.liveText)
        case .warn: AnyShapeStyle(Theme.warnText)
        case .alert: AnyShapeStyle(Theme.alertText)
        case .you: AnyShapeStyle(Theme.youText)
        case .selected: AnyShapeStyle(.white)
        }
    }

    private var background: AnyShapeStyle {
        switch tone {
        case .neutral: raised ? AnyShapeStyle(Theme.raised) : AnyShapeStyle(.quinary)
        case .live: AnyShapeStyle(Theme.live.opacity(0.12))
        case .warn: AnyShapeStyle(Theme.warn.opacity(0.12))
        case .alert: AnyShapeStyle(Theme.alert.opacity(0.12))
        case .you: AnyShapeStyle(Theme.you.opacity(0.12))
        case .selected: AnyShapeStyle(Theme.actionFill)
        }
    }
}
