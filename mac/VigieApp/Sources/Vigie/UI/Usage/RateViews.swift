import SwiftUI

extension Fmt {
    /// Pourcentage fin pour la consommation : « 0,03 % », « 1,2 % », « 14 % ».
    static func pctFine(_ value: Double) -> String {
        "\(fine(value)) %"
    }

    /// Débit : « 1,2 %/h ».
    static func rate(_ value: Double) -> String {
        "\(fine(value)) %/h"
    }

    /// « 48 k tokens/min », « 850 tokens/min ».
    static func tokensPerMin(_ value: Double) -> String {
        "\(tokensShort(value)) tokens/min"
    }

    static func tokensShort(_ value: Double) -> String {
        value < 1000 ? Fmt.int(Int(value.rounded())) : Fmt.tokens(Int(value.rounded()))
    }

    private static func fine(_ value: Double) -> String {
        let digits = value == 0 || value >= 10 ? 0 : (value < 0.1 ? 2 : 1)
        return value.formatted(.number.precision(.fractionLength(0...digits)).locale(locale))
    }
}

/// Mini-courbe (30 valeurs, une par minute), sans axes.
struct Sparkline: View {
    let values: [Double]
    var color: Color = .secondary

    var body: some View {
        Canvas { context, size in
            guard values.count > 1 else { return }
            let top = max(values.max() ?? 0, 0.0001)
            let stepX = size.width / CGFloat(values.count - 1)
            var line = Path()
            for (index, value) in values.enumerated() {
                let point = CGPoint(x: CGFloat(index) * stepX,
                                    y: size.height - 1 - CGFloat(max(0, value) / top) * (size.height - 2))
                if index == 0 { line.move(to: point) } else { line.addLine(to: point) }
            }
            var area = line
            area.addLine(to: CGPoint(x: size.width, y: size.height))
            area.addLine(to: CGPoint(x: 0, y: size.height))
            area.closeSubpath()
            context.fill(area, with: .color(color.opacity(0.15)))
            context.stroke(line, with: .color(color), style: StrokeStyle(lineWidth: 1.2, lineCap: .round, lineJoin: .round))
        }
        .accessibilityHidden(true)
    }
}

/// Consommation du moment d'une conversation : mini-courbe et « 1,2 %/h » (tokens au survol).
struct RateBadge: View {
    let rate: ConversationRate
    var alert = false
    var compact = false
    /// La conversation travaille : courbe en vert.
    var live = false

    var body: some View {
        HStack(spacing: 5) {
            if rate.spark.count > 1 {
                Sparkline(values: rate.spark, color: alert ? Theme.warn : live ? Theme.live : .secondary)
                    .frame(width: compact ? 34 : 44, height: compact ? 12 : 14)
            }
            if let pct = rate.weekPctPerHour {
                HStack(spacing: 1) {
                    Text(Fmt.rate(pct))
                        .monospacedDigit()
                    if let symbol = trendSymbol {
                        Image(systemName: symbol)
                            .imageScale(.small)
                            .foregroundStyle(.tertiary)
                    }
                }
                .foregroundStyle(alert ? AnyShapeStyle(Theme.warn) : AnyShapeStyle(.secondary))
            }
        }
        .lineLimit(1)
        .fixedSize()
        .help(help)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(help)
    }

    private var trendSymbol: String? {
        switch rate.trend {
        case "up": "arrow.up.right"
        case "down": "arrow.down.right"
        default: nil
        }
    }

    private var help: String {
        var parts: [String] = []
        if let pct = rate.weekPctPerHour { parts.append("\(Fmt.rate(pct)) de la semaine du compte") }
        if let tokens = rate.tokensPerMin { parts.append(Fmt.tokensPerMin(tokens)) }
        parts.append("10 dernières minutes, agents compris")
        return parts.joined(separator: " · ")
    }
}

extension VigieStore {
    /// Débit du moment par compte (somme des conversations ouvertes), pour la barre des menus.
    var ratesByAccount: [(account: Account?, id: String, pctPerHour: Double, tokensPerMin: Double)] {
        var totals: [String: (Double, Double)] = [:]
        var order: [String] = []
        for conversation in conversations where conversation.isOpen {
            guard let rate = conversation.rate, rate.weekPctPerHour != nil || rate.tokensPerMin != nil else { continue }
            let id = conversation.accountId ?? account(nil)?.id ?? "?"
            if totals[id] == nil { order.append(id) }
            let current = totals[id] ?? (0, 0)
            totals[id] = (current.0 + (rate.weekPctPerHour ?? 0), current.1 + (rate.tokensPerMin ?? 0))
        }
        return order.map { id in (account(id), id, totals[id]?.0 ?? 0, totals[id]?.1 ?? 0) }
    }
}
