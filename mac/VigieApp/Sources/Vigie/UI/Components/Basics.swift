import SwiftUI

/// Pastille d'état d'une conversation : accent quand elle travaille, rouge quand elle t'attend,
/// grise au repos, cerclée quand elle est fermée.
struct StatusDot: View {
    let status: ConversationStatus
    var size: CGFloat = 8

    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiate

    var body: some View {
        Group {
            if differentiate {
                Image(systemName: Theme.symbol(for: status))
                    .foregroundStyle(Theme.color(for: status))
                    .font(.system(size: size + 4))
            } else if status == .closed || status == .unknown {
                Circle()
                    .strokeBorder(.tertiary, lineWidth: 1.5)
                    .frame(width: size, height: size)
            } else {
                Circle()
                    .fill(Theme.color(for: status))
                    .frame(width: size, height: size)
            }
        }
        .frame(width: size + 4)
        .accessibilityLabel(Theme.label(for: status))
    }
}

/// Ancienne étiquette (« Par toi », « Créé ») : désormais une simple `Chip` neutre, ou rouge pour ce qui t'attend.
/// Gardée pour les écrans pas encore passés à `Chip` ; à remplacer par `Chip(text, symbol:, tone:)`.
struct Pill: View {
    let text: String
    var alert = false
    var symbol: String?

    var body: some View {
        Chip(text, symbol: symbol, tone: alert ? .alert : .neutral)
    }
}

/// Icône d'une rangée : SF Symbol monochrome, alignée sur une colonne fixe.
/// Repère fixe « en cours ». Une roue animée en continu fait redessiner l'écran à chaque image (jusqu'à 120 fois par
/// seconde) tant qu'un agent travaille, parfois des heures ; la durée affichée à côté dit déjà que ça avance.
struct RunningMark: View {
    var size: CGFloat = 8
    var width: CGFloat = 22

    var body: some View {
        Circle()
            .fill(Theme.live)
            .frame(width: size, height: size)
            .frame(width: width)
            .accessibilityLabel("En cours")
    }
}

struct RowIcon: View {
    let symbol: String
    var alert = false

    var body: some View {
        Image(systemName: symbol)
            .symbolRenderingMode(.hierarchical)
            .foregroundStyle(alert ? AnyShapeStyle(Theme.alert) : AnyShapeStyle(.secondary))
            .font(.system(size: 15))
            .frame(width: 22)
            .accessibilityHidden(true)
    }
}

/// Compteur en pastille : gris par défaut ; rouge (`urgent`) seulement pour les décisions qui t'attendent (« À
/// décider » : le badge rouge a la même définition partout, `store.decisionCount`) ; orange (`warn`) pour ce qui est à
/// surveiller sans urgence (« En fond »).
/// Orange lisible : fond `Theme.warnText` (orange foncé en clair) et chiffre `Theme.onWarn` (blanc en clair, noir à
/// 85 % en sombre) ; l'orange système sous un chiffre blanc ne faisait que 2,3:1.
/// Dans un titre de section, un compteur qui n'est pas urgent s'écrit en chiffre gris (`SectionHeader(count:)`), pas
/// en pastille.
struct CountBadge: View {
    let count: Int
    var urgent = false
    /// À surveiller, sans urgence (orange).
    var warn = false
    /// Ce que VoiceOver dit (« 3 à décider ») ; sinon déduit du ton.
    var label: String? = nil

    var body: some View {
        Text(count, format: .number)
            .font(.caption.bold())
            .monospacedDigit()
            .foregroundStyle(urgent ? AnyShapeStyle(.white) : warn ? AnyShapeStyle(Theme.onWarn) : AnyShapeStyle(.secondary))
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .frame(minWidth: 18)
            .background(urgent ? AnyShapeStyle(Theme.alert) : warn ? AnyShapeStyle(Theme.warnText) : AnyShapeStyle(.quaternary), in: .capsule)
            .accessibilityLabel(label ?? (urgent ? "\(count) à décider" : warn ? "\(count) à surveiller" : "\(count) à regarder"))
    }
}

/// Barre de remplissage fine (jauge de crédits) : ton calme, rouge au-delà de 90 %, vide sans relevé.
struct UsageBar: View {
    let pct: Double?
    var height: CGFloat = 5

    var body: some View {
        Capsule()
            .fill(.quaternary)
            .frame(height: height)
            .overlay(alignment: .leading) {
                if let pct {
                    GeometryReader { proxy in
                        Capsule()
                            .fill(Theme.gaugeTint(pct))
                            .frame(width: max(height, proxy.size.width * min(max(pct, 0), 100) / 100))
                    }
                }
            }
            .clipShape(.capsule)
            .accessibilityHidden(true)
    }
}

/// « mis à jour il y a 12 min · 01:18 » : l'âge d'une information, tenu à jour toutes les 30 s. Un seul verbe partout
/// (« mis à jour », jamais « relevé » ni « vérifié » seul). Hors d'une vue (sous-titre de fenêtre, `.help`) :
/// `Freshness.text(date: d, now: store.now)`.
struct Freshness: View {
    @Environment(VigieStore.self) private var store
    let date: Date?
    var prefix = "mis à jour"

    var body: some View {
        if let date {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                let now = store.isDemo ? store.now : context.date
                Text(Self.text(prefix: prefix, date: date, now: now))
                    .monospacedDigit()
                    .help(date.formatted(.dateTime.weekday(.wide).day().month(.wide).hour().minute().locale(Fmt.locale)))
            }
        }
    }

    /// Le même texte, pour un endroit qui n'accepte pas une vue (`.navigationSubtitle`, `.help`) : « mis à jour il y a
    /// 12 min · 01:18 ». Il ne se met pas à jour tout seul : la vue qui l'appelle se redessine avec `store.now`.
    static func text(prefix: String = "mis à jour", date: Date, now: Date) -> String {
        let head = prefix.isEmpty ? "" : prefix + " "
        return "\(head)\(Fmt.ago(date, now: now)) · \(Fmt.when(date, now: now))"
    }
}

/// « Tout afficher (24) » sous une liste raccourcie.
struct ShowAllButton: View {
    let count: Int
    let action: () -> Void

    var body: some View {
        Button("Tout afficher (\(Fmt.int(count)))", action: action)
            .buttonStyle(.link)
            .font(.callout)
    }
}

/// Des éléments côte à côte qui passent à la ligne quand la place manque (puces, boutons) : jamais plus larges que
/// leur conteneur.
struct WrapLayout: Layout {
    var spacing: CGFloat = 6
    var lineSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            let item = min(size.width, width)
            if x > 0 && x + item > width { y += line + lineSpacing; x = 0; line = 0 }
            x += item + spacing
            line = max(line, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, width), height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            let item = min(size.width, bounds.width)
            if x > bounds.minX && x + item > bounds.maxX { y += line + lineSpacing; x = bounds.minX; line = 0 }
            view.place(at: CGPoint(x: x, y: y + (line > 0 ? 0 : 0)), proposal: ProposedViewSize(width: item, height: size.height))
            x += item + spacing
            line = max(line, size.height)
        }
    }
}
