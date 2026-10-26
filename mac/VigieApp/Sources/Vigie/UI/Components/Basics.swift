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

/// Étiquette courte et discrète (« Par toi », « Créé »). Rouge seulement pour ce qui t'attend.
struct Pill: View {
    let text: String
    var alert = false
    var symbol: String?

    var body: some View {
        HStack(spacing: 3) {
            if let symbol {
                Image(systemName: symbol)
                    .imageScale(.small)
            }
            Text(text)
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(alert ? AnyShapeStyle(Color.red) : AnyShapeStyle(.secondary))
        .padding(.horizontal, 7)
        .padding(.vertical, 2)
        .background(alert ? AnyShapeStyle(Color.red.opacity(0.12)) : AnyShapeStyle(.quaternary), in: .capsule)
        .fixedSize()
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
            .foregroundStyle(alert ? AnyShapeStyle(Color.red) : AnyShapeStyle(.secondary))
            .font(.system(size: 15))
            .frame(width: 22)
            .accessibilityHidden(true)
    }
}

/// Compteur « à regarder » : gris, rouge seulement quand quelque chose t'attend.
struct CountBadge: View {
    let count: Int
    var urgent = false

    var body: some View {
        Text(count, format: .number)
            .font(.caption.bold())
            .monospacedDigit()
            .foregroundStyle(urgent ? AnyShapeStyle(.white) : AnyShapeStyle(.secondary))
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .frame(minWidth: 18)
            .background(urgent ? AnyShapeStyle(Color.red) : AnyShapeStyle(.quaternary), in: .capsule)
            .accessibilityLabel(urgent ? "\(count) à regarder, dont ce qui t'attend" : "\(count) à regarder")
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

/// « mis à jour il y a 12 min · 01:18 » : l'âge d'une information, tenu à jour toutes les 30 s.
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

    static func text(prefix: String, date: Date, now: Date) -> String {
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
