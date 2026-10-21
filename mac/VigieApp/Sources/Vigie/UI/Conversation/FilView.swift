import SwiftUI

/// Le fil d'une conversation : seulement les jalons, groupés par jour. Tes demandes servent de repères ;
/// ses comptes rendus, commits, déploiements, agents finis, tests rouges puis verts, artefacts, limites.
struct FilView: View {
    @Environment(VigieStore.self) private var store
    let milestones: [Row<Milestone>]

    @State private var showAll = false
    private static let shown = 30

    var body: some View {
        if milestones.isEmpty {
            EmptyRow(text: "Rien de marquant pour l'instant")
        } else {
            let rows = showAll ? milestones : Array(milestones.prefix(Self.shown))
            ForEach(days(rows), id: \.0) { day, items in
                Text(day)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.top, 4)
                ForEach(items) { row in
                    MilestoneRow(milestone: row.value)
                }
            }
            if !showAll && milestones.count > Self.shown {
                ShowAllButton(count: milestones.count) { showAll = true }
            }
        }
    }

    /// « Aujourd'hui », « Hier », « lun. 19 oct. », dans l'ordre du fil.
    private func days(_ rows: [Row<Milestone>]) -> [(String, [Row<Milestone>])] {
        var out: [(String, [Row<Milestone>])] = []
        let calendar = Calendar.current
        for row in rows {
            let date = row.value.ts ?? .distantPast
            let label: String
            if calendar.isDate(date, inSameDayAs: store.now) {
                label = "Aujourd'hui"
            } else if let yesterday = calendar.date(byAdding: .day, value: -1, to: store.now), calendar.isDate(date, inSameDayAs: yesterday) {
                label = "Hier"
            } else {
                label = date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).locale(Fmt.locale))
            }
            if out.last?.0 == label { out[out.count - 1].1.append(row) } else { out.append((label, [row])) }
        }
        return out
    }
}

struct MilestoneRow: View {
    @Environment(VigieStore.self) private var store
    let milestone: Milestone

    @State private var expanded = false

    var body: some View {
        let kind = milestone.milestoneKind
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(milestone.ts.map(Fmt.time) ?? "")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.tertiary)
                .frame(width: 38, alignment: .trailing)
            Image(systemName: symbol(kind))
                .foregroundStyle(tint(kind))
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(label(kind))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(title(kind))
                        .fontWeight(kind == .prompt ? .medium : .regular)
                        .lineLimit(expanded ? nil : 2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let line = secondLine, !line.isEmpty {
                    Text(line)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(expanded ? nil : 2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .textSelection(.enabled)
            Spacer(minLength: 0)
            if let url = milestone.url, !url.isEmpty {
                Button("Ouvrir") { SystemActions.open(url) }
                    .buttonStyle(.link)
            }
        }
        .padding(.vertical, kind == .prompt ? 6 : 2)
        .padding(.horizontal, kind == .prompt ? 8 : 0)
        .background(kind == .prompt ? AnyShapeStyle(.quaternary.opacity(0.5)) : AnyShapeStyle(.clear), in: .rect(cornerRadius: 8))
        .contentShape(.rect)
        .onTapGesture { withAnimation(.smooth) { expanded.toggle() } }
    }

    private var secondLine: String? {
        let parts = [milestone.detail, milestone.by.map { "par \($0)" }].compactMap { $0?.isEmpty == false ? $0 : nil }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func title(_ kind: Milestone.Kind) -> String {
        let text = milestone.title ?? ""
        return kind == .prompt ? "« \(text) »" : text
    }

    private func label(_ kind: Milestone.Kind) -> String {
        switch kind {
        case .prompt: "Ta demande"
        case .report: "Compte rendu"
        case .commit: "Commit"
        case .push: "Push"
        case .deploy: "Déploiement"
        case .pr: "Fusion"
        case .agent: milestone.ok == false ? "Agent en échec" : "Agent fini"
        case .workflow: milestone.ok == false ? "Workflow en échec" : "Workflow fini"
        case .tests: milestone.ok == false ? "Tests en échec" : "Tests au vert"
        case .artifact: "Publié"
        case .limit: "Limite"
        case .other: ""
        }
    }

    private func symbol(_ kind: Milestone.Kind) -> String {
        switch kind {
        case .prompt: "text.bubble"
        case .report: "text.alignleft"
        case .commit: Icon.commit
        case .push: Icon.push
        case .deploy: "icloud.and.arrow.up"
        case .pr: "arrow.triangle.merge"
        case .agent: Icon.agent
        case .workflow: Icon.workflow
        case .tests: milestone.ok == false ? Icon.testFailed : Icon.test
        case .artifact: Icon.artifact
        case .limit: Icon.limit
        case .other: Icon.other
        }
    }

    /// Couleur seulement pour ce qui va mal : tests en échec (rouge), agent ou workflow en échec, limite (orange).
    private func tint(_ kind: Milestone.Kind) -> Color {
        switch kind {
        case .tests where milestone.ok == false: Theme.alert
        case .agent, .workflow: milestone.ok == false ? Theme.warn : .secondary
        case .limit: Theme.warn
        case .prompt: .primary
        default: .secondary
        }
    }
}
