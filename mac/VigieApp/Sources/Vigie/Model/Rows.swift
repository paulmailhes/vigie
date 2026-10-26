import Foundation

/// Une ligne avec une identité stable, calculée une seule fois quand les données changent.
struct Row<Value: Equatable & Sendable>: Identifiable, Equatable, Sendable {
    let id: String
    let value: Value
}

enum RowIDs {
    /// Identifiants stables pour une liste « plus récent d'abord » sans identifiant :
    /// les doublons sont numérotés depuis le plus ancien, donc un nouvel élément ne décale rien.
    static func make<Value>(_ items: [Value], key: (Value) -> String) -> [Row<Value>] {
        var seen: [String: Int] = [:]
        var reversed: [Row<Value>] = []
        reversed.reserveCapacity(items.count)
        for item in items.reversed() {
            let base = key(item)
            let count = seen[base, default: 0]
            seen[base] = count + 1
            reversed.append(Row(id: count == 0 ? base : "\(base)#\(count)", value: item))
        }
        return reversed.reversed()
    }

    static func stamp(_ date: Date?) -> String {
        date.map { String(Int($0.timeIntervalSince1970)) } ?? "-"
    }
}

/// Le détail d'une conversation, prêt pour l'affichage.
struct ConversationDetailModel: Equatable, Sendable {
    let raw: ConversationDetail
    let accepted: [Row<AcceptedItem>]
    let tests: [Row<TestRun>]
    let artifacts: [Row<Artifact>]
    let files: [Row<FileItem>]
    let filesByLocation: [(FileLocation, [Row<FileItem>])]
    let runningAgents: [AgentRun]
    let doneAgents: [AgentRun]
    let mcpGroups: [(MCPGroup, [ConversationMCP])]
    let testsFailedCount: Int
    let milestones: [Row<Milestone>]
    /// Les documents que la conversation tient à jour (retours.md, ETAT.md, un plan…) : souvent sa feuille de route.
    let trackingDocs: [FileItem]
    /// Fil « ses actions et leur résultat » : les décisions de Vigie, plus ce que Claude Code a validé lui-même (mode
    /// auto) : commandes, fichiers modifiés, outils, agents ; sans les lectures. Calculé une fois par détail.
    let feed: [Row<AcceptedItem>]

    init(_ detail: ConversationDetail) {
        raw = detail
        accepted = RowIDs.make(detail.accepted) {
            "\(RowIDs.stamp($0.ts))|\($0.kind ?? "")|\($0.title ?? "")|\($0.detail ?? "")"
        }
        tests = RowIDs.make(detail.tests) {
            "\(RowIDs.stamp($0.ts))|\($0.kind ?? "")|\($0.title ?? "")"
        }
        artifacts = RowIDs.make(detail.artifacts) { $0.url ?? "\($0.title ?? "")|\(RowIDs.stamp($0.ts))" }
        files = RowIDs.make(detail.files) { $0.path }
        filesByLocation = FileLocation.allCases.compactMap { location in
            let rows = RowIDs.make(detail.files.filter { $0.fileLocation == location }) { $0.path }
            return rows.isEmpty ? nil : (location, rows)
        }
        runningAgents = detail.agents?.running ?? []
        doneAgents = detail.agents?.done ?? []
        mcpGroups = MCPGroup.allCases.compactMap { group in
            let items = detail.mcp
                .filter { MCPGroup(scope: $0.mcpScope) == group }
                .sorted { ($0.enabled ?? true ? 0 : 1, -($0.uses ?? 0), $0.name) < ($1.enabled ?? true ? 0 : 1, -($1.uses ?? 0), $1.name) }
            return items.isEmpty ? nil : (group, items)
        }
        testsFailedCount = detail.tests.count(where: { $0.outcome == .failed })
        milestones = RowIDs.make(detail.milestones) { "\(RowIDs.stamp($0.ts))|\($0.kind ?? "")|\($0.title ?? "")" }
        let week = Date.now.addingTimeInterval(-7 * 86_400)
        trackingDocs = Array(detail.files
            .filter { file in
                file.ext?.lowercased() == "md" && file.fileLocation == .project && (file.writes ?? 0) >= 2
                    && (file.ts ?? .distantPast) > week && !["CLAUDE.md", "AGENTS.md"].contains(file.displayName)
            }
            .sorted { ($0.ts ?? .distantPast) > ($1.ts ?? .distantPast) }
            .prefix(3))
        feed = Self.feed(accepted: accepted, activity: detail.activity)
    }

    private static func feed(accepted: [Row<AcceptedItem>], activity: [ActivityItem]) -> [Row<AcceptedItem>] {
        let skip = ["Lit ", "Cherche ", "Liste ", "Met à jour", "Charge la compétence", "Ajoute une tâche", "Te pose une question"]
        // décisions de Vigie, par sorte d'action et par seconde : une action vue à ±4 s y est déjà
        var decided = Set<String>()
        for row in accepted { if let ts = row.value.ts { decided.insert("\(row.value.itemKind)|\(Int(ts.timeIntervalSince1970))") } }
        var extra: [AcceptedItem] = []
        for action in activity {
            guard let ts = action.ts, let title = action.title else { continue }
            if skip.contains(where: { title.hasPrefix($0) }) { continue }
            let kind = ItemKind(raw: action.kind)
            let second = Int(ts.timeIntervalSince1970)
            if (-4...4).contains(where: { decided.contains("\(kind)|\(second + $0)") }) { continue }
            extra.append(AcceptedItem(ts: ts, kind: action.kind, title: title, detail: action.detail, decision: "auto", agent: action.agent))
        }
        let all = (accepted.map(\.value) + extra).sorted { ($0.ts ?? .distantPast) > ($1.ts ?? .distantPast) }
        return RowIDs.make(all) { "\(RowIDs.stamp($0.ts))|\($0.kind ?? "")|\($0.title ?? "")" }
    }

    static func == (lhs: ConversationDetailModel, rhs: ConversationDetailModel) -> Bool {
        lhs.raw == rhs.raw
    }
}

/// Les trois étages de MCP, dans l'ordre d'affichage.
enum MCPGroup: Int, CaseIterable, Sendable {
    case mac, project, connector

    init(scope: MCPScope) {
        switch scope {
        case .project, .local: self = .project
        case .connector: self = .connector
        case .user, .plugin, .other: self = .mac
        }
    }
}
