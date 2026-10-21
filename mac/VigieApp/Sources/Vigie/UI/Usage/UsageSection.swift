import Charts
import SwiftUI

/// Bloc « Consommation » de la vue d'ensemble : une courbe par conversation sur 1 h, 10 h ou 20 h,
/// en % de la semaine du compte (tokens au survol), cases pour afficher ou masquer chaque conversation.
struct UsageSection: View {
    @Environment(VigieStore.self) private var store
    @AppStorage("usage.window") private var spanRaw = UsageSpan.hour.rawValue
    /// Le débit (% de la semaine par heure), jamais un total qui ne fait que monter.
    private let cumulative = false
    /// Conversations masquées (identifiants séparés par des virgules) : les nouvelles s'affichent d'office.
    @AppStorage("usage.hidden") private var hiddenRaw = ""
    @State private var selected: Date?

    private var span: UsageSpan { UsageSpan(rawValue: spanRaw) ?? .hour }

    var body: some View {
        CardSection {
            content
        } header: {
            header
        }
        .task(id: spanRaw) { await store.followUsage(span) }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Label("Consommation", systemImage: Icon.usage)
                .labelStyle(.titleOnly)
            Spacer(minLength: 8)
            Text("% de la semaine par heure")
                .font(.caption)
                .foregroundStyle(.secondary)
            Picker("Période", selection: $spanRaw) {
                ForEach(UsageSpan.allCases) { span in
                    Text(span.label).tag(span.rawValue)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
        }
        .font(.body)
        .controlSize(.small)
    }

    @ViewBuilder
    private var content: some View {
        if let series = store.usageSeries[span.rawValue] {
            // les conversations ouvertes seulement (les fermées et les dossiers annexes encombraient la courbe)
            let lines = UsageLine.make(series, store: store, span: span, cumulative: cumulative).filter(\.running)
            if lines.isEmpty {
                Label("Aucune consommation sur cette période", systemImage: "moon.zzz")
                    .foregroundStyle(.secondary)
            } else {
                AccountTotals(series: series, span: span)
                let shownLines = lines.filter { !hidden.contains($0.id) }
                UsageChart(lines: shownLines.isEmpty ? lines : shownLines, allIDs: lines.map(\.id),
                           cumulative: cumulative, span: span, selected: $selected)
                UsageLegend(lines: lines, hidden: hidden, cumulative: cumulative) { id, visible in
                    setVisible(id, visible)
                } setAll: { visible in
                    hiddenRaw = visible ? "" : lines.map(\.id).joined(separator: ",")
                }
            }
        } else if store.usageUnavailable {
            Label("Le moteur ne fournit pas encore la consommation", systemImage: "chart.line.downtrend.xyaxis")
                .foregroundStyle(.secondary)
        } else {
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity, minHeight: 60)
        }
    }

    private var hidden: Set<String> {
        Set(hiddenRaw.split(separator: ",").map(String.init))
    }

    private func setVisible(_ id: String, _ visible: Bool) {
        var set = hidden
        if visible { set.remove(id) } else { set.insert(id) }
        hiddenRaw = set.sorted().joined(separator: ",")
    }
}

/// Une courbe : ses points dans l'unité choisie (cumulé ou par heure).
struct UsageLine: Identifiable, Equatable {
    struct Point: Identifiable, Equatable {
        var id: Int
        var t: Date
        var value: Double
        var tokens: Double
    }

    var id: String
    var name: String
    var subtitle: String?
    /// Compte dont elle consomme les tokens (Travail 1, Travail 2…).
    var account: String?
    var color: Color
    var running: Bool
    var totalPct: Double
    var totalTokens: Double
    var points: [Point]

    static let palette: [Color] = [.blue, .orange, .green, .pink, .purple, .teal, .yellow, .red, .indigo, .mint, .brown, .cyan]

    @MainActor
    static func make(_ series: UsageSeries, store: VigieStore, span: UsageSpan, cumulative: Bool) -> [UsageLine] {
        let step = max(series.stepMin ?? span.defaultStep, 1)
        // Couleur stable : rang de l'identifiant parmi les conversations de la période.
        let colorIndex = Dictionary(uniqueKeysWithValues: series.conversations.map(\.id).sorted().enumerated().map { ($1, $0) })
        var lines: [UsageLine] = []
        for conversation in series.conversations {
            var points: [Point] = []
            var sum = 0.0
            var tokens = 0.0
            for (index, point) in conversation.points.enumerated() {
                guard let t = point.t else { continue }
                let pct = point.weekPct ?? 0
                sum += pct
                tokens += point.tokens ?? 0
                points.append(Point(id: index, t: t,
                                    value: cumulative ? sum : pct * 60 / step,
                                    tokens: cumulative ? tokens : point.tokens ?? 0))
            }
            guard !points.isEmpty else { continue }
            let live = store.conversation(conversation.id)
            let name = live?.shortTitle
                ?? conversation.project.map { ProjectName.display($0, cwd: conversation.cwd) }
                ?? conversation.title ?? "Conversation"
            let title = live?.title ?? conversation.title
            let accountID = live?.accountId ?? conversation.accountId
            lines.append(UsageLine(id: conversation.id, name: name,
                                   subtitle: title == name ? nil : title,
                                   account: accountID.flatMap { store.account($0)?.displayName },
                                   color: palette[(colorIndex[conversation.id] ?? 0) % palette.count],
                                   running: live.map(\.isOpen) ?? (conversation.running ?? false),
                                   totalPct: conversation.totalPct, totalTokens: conversation.totalTokens,
                                   points: points))
        }
        // Rangées par compte, puis les plus gourmandes d'abord.
        return lines.sorted { ($0.account ?? "~", -$0.totalPct) < ($1.account ?? "~", -$1.totalPct) }
    }

    /// Le point le plus proche d'une heure (survol).
    func point(near date: Date) -> Point? {
        points.min { abs($0.t.timeIntervalSince(date)) < abs($1.t.timeIntervalSince(date)) }
    }
}

/// Total par compte sur la période, et le débit du moment.
private struct AccountTotals: View {
    @Environment(VigieStore.self) private var store
    let series: UsageSeries
    let span: UsageSpan

    var body: some View {
        let rates = Dictionary(store.ratesByAccount.map { ($0.id, $0.pctPerHour) }, uniquingKeysWith: { first, _ in first })
        HStack(spacing: 18) {
            ForEach(series.accounts.filter { $0.totalPct > 0 || rates[$0.id] != nil }) { account in
                let name = store.account(account.id)?.displayName ?? account.label ?? account.id
                HStack(spacing: 6) {
                    Image(systemName: Icon.account)
                        .foregroundStyle(.secondary)
                    Text(name)
                    Text("\(Fmt.pctFine(account.totalPct)) en \(span.label)")
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                    if let rate = rates[account.id] {
                        Text("· \(Fmt.rate(rate)) maintenant")
                            .monospacedDigit()
                            .foregroundStyle(.tertiary)
                    }
                }
                .font(.callout)
                .lineLimit(1)
                .help("\(name) : \(Fmt.pctFine(account.totalPct)) de sa semaine consommés sur \(span.label)")
            }
            Spacer(minLength: 0)
        }
    }
}

/// Le graphique (Swift Charts) avec infobulle au survol.
private struct UsageChart: View {
    let lines: [UsageLine]
    let allIDs: [String]
    let cumulative: Bool
    let span: UsageSpan
    @Binding var selected: Date?

    var body: some View {
        Chart {
            ForEach(lines) { line in
                ForEach(line.points) { point in
                    LineMark(x: .value("Heure", point.t),
                             y: .value("Consommation", point.value),
                             series: .value("Conversation", line.id))
                        .foregroundStyle(line.color)
                        .interpolationMethod(.monotone)
                        .lineStyle(StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round))
                }
            }
            if let selected {
                RuleMark(x: .value("Heure", selected))
                    .foregroundStyle(Color.secondary.opacity(0.35))
                    .annotation(position: .top, spacing: 4,
                                overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) {
                        tooltip(at: selected)
                    }
            }
        }
        .chartXSelection(value: $selected)
        .chartYAxis {
            AxisMarks(position: .leading) { value in
                AxisGridLine()
                AxisValueLabel {
                    if let number = value.as(Double.self) {
                        Text(cumulative ? Fmt.pctFine(number) : Fmt.rate(number))
                    }
                }
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 6)) { _ in
                AxisGridLine()
                AxisValueLabel(format: .dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
            }
        }
        .environment(\.locale, Fmt.locale)
        .frame(height: 220)
        .overlay {
            if lines.isEmpty {
                Text("Toutes les conversations sont masquées")
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityLabel("Consommation par conversation sur \(span.label)")
    }

    private func tooltip(at date: Date) -> some View {
        let rows = lines.compactMap { line in line.point(near: date).map { (line, $0) } }
            .sorted { $0.1.value > $1.1.value }
        return VStack(alignment: .leading, spacing: 3) {
            Text(Fmt.time(rows.first?.1.t ?? date))
                .font(.caption.bold())
                .monospacedDigit()
            ForEach(Array(rows.prefix(8).enumerated()), id: \.offset) { _, row in
                let (line, point) = row
                HStack(spacing: 6) {
                    Circle().fill(line.color).frame(width: 7, height: 7)
                    Text(line.name).lineLimit(1)
                    if let account = line.account {
                        Text(account).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 10)
                    Text(cumulative ? Fmt.pctFine(point.value) : Fmt.rate(point.value))
                        .monospacedDigit()
                    Text(Fmt.tokensShort(point.tokens) + " tokens")
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                .font(.caption)
            }
        }
        .padding(8)
        .frame(minWidth: 220)
        .background(.regularMaterial, in: .rect(cornerRadius: 8))
        .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
    }
}

/// Légende : une case par conversation (mémorisée), total sur la période.
private struct UsageLegend: View {
    let lines: [UsageLine]
    let hidden: Set<String>
    let cumulative: Bool
    let setVisible: (String, Bool) -> Void
    let setAll: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 250), spacing: 16, alignment: .leading)],
                      alignment: .leading, spacing: 6) {
                ForEach(lines) { line in
                    Toggle(isOn: Binding(get: { !hidden.contains(line.id) }, set: { setVisible(line.id, $0) })) {
                        row(line)
                    }
                    .toggleStyle(.checkbox)
                    .help(help(line))
                }
            }
            HStack(spacing: 12) {
                Button("Tout afficher") { setAll(true) }
                    .disabled(hidden.isEmpty)
                Button("Tout masquer") { setAll(false) }
                    .disabled(lines.allSatisfy { hidden.contains($0.id) })
            }
            .buttonStyle(.link)
            .font(.callout)
        }
    }

    private func row(_ line: UsageLine) -> some View {
        HStack(spacing: 6) {
            Circle()
                .fill(line.color)
                .frame(width: 8, height: 8)
            Text(line.name)
                .lineLimit(1)
            if let account = line.account {
                Text(account)
                    .font(.caption)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(.quaternary, in: .capsule)
                    .lineLimit(1)
                    .help("Consomme les tokens de \(account)")
            }
            if !line.running {
                Text("fermée")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 6)
            Text(Fmt.pctFine(line.totalPct))
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
        .font(.callout)
    }

    private func help(_ line: UsageLine) -> String {
        var parts = [line.subtitle ?? line.name, "\(Fmt.pctFine(line.totalPct)) de la semaine de \(line.account ?? "son compte")"]
        if line.totalTokens > 0 { parts.append("\(Fmt.tokensShort(line.totalTokens)) tokens") }
        return parts.joined(separator: " · ")
    }
}
