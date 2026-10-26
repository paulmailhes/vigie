import Foundation

/// Ce qu'affiche la carte d'une conversation : les champs du moteur, sinon calculés depuis le détail.
struct CardData: Equatable {
    struct Failure: Equatable {
        var title: String
        var line: String?
    }

    var progressDone = 0
    var progressTotal = 0
    var progressLabel: String?
    var current: String?

    var testsFailed = 0
    var testsRunning = 0
    var testsLastOk: Bool?
    var testsLastTs: Date?
    var testsLastTitle: String?
    var failures: [Failure] = []

    var artifactsCount: Int?
    var lastArtifact: String?
    var lastArtifactURL: String?

    var hasProgress: Bool { progressTotal > 0 }

    init(summary: ConversationSummary, detail: ConversationDetail?, since: Date?, now: Date) {
        fillProgress(summary.progress, detail: detail)
        fillTests(summary.tests, detail: detail, now: now)
        fillArtifacts(summary.artifacts, detail: detail)
    }

    private mutating func fillProgress(_ progress: CardProgress?, detail: ConversationDetail?) {
        if let progress, let total = progress.total, total > 0 {
            progressDone = min(progress.done ?? 0, total)
            progressTotal = total
            progressLabel = progress.label
            current = progress.current
            return
        }
        if let plan = detail?.now?.plan, plan.totalCount > 0 {
            progressDone = plan.doneCount
            progressTotal = plan.totalCount
            progressLabel = plan.title
            current = plan.currentIndex.map { plan.steps[$0].label }
            return
        }
        let tasks = detail?.now?.tasks ?? []
        if !tasks.isEmpty {
            progressDone = tasks.count(where: { $0.state == .done })
            progressTotal = tasks.count
            current = (tasks.first { $0.state == .doing } ?? tasks.first { $0.state == .todo })?.text
        }
    }

    private mutating func fillTests(_ tests: CardTests?, detail: ConversationDetail?, now: Date) {
        if let tests {
            testsFailed = tests.failedRecent ?? 0
            testsRunning = tests.running ?? 0
            testsLastOk = tests.lastOk
            testsLastTs = tests.lastTs
            testsLastTitle = tests.lastTitle
            failures = tests.failures.compactMap { failure in
                guard let title = failure.title ?? failure.line else { return nil }
                return Failure(title: title, line: failure.title == nil ? nil : failure.line)
            }
            return
        }
        guard let runs = detail?.tests, !runs.isEmpty else { return }
        // Plus récent d'abord : un échec compte s'il date de moins de 2 h et qu'aucune réussite
        // du même genre ne l'a suivi.
        var passedKinds = Set<String>()
        var failedKinds = Set<String>()
        for run in runs {
            let kind = run.kind ?? "other"
            switch run.outcome {
            case .pending:
                testsRunning += 1
            case .passed:
                passedKinds.insert(kind)
                if testsLastOk == nil { record(run, ok: true) }
            case .expectedFail:
                continue
            case .failed:
                if testsLastOk == nil { record(run, ok: false) }
                guard !passedKinds.contains(kind), let ts = run.ts, now.timeIntervalSince(ts) < 2 * 3600 else { continue }
                testsFailed += 1
                if failedKinds.insert(kind + "|" + (run.title ?? "")).inserted, failures.count < 3 {
                    failures.append(Failure(title: run.title ?? Theme.title(for: run.testKind), line: run.line))
                }
            }
        }
    }

    private mutating func record(_ run: TestRun, ok: Bool) {
        testsLastOk = ok
        testsLastTs = run.ts
        testsLastTitle = run.title
    }

    private mutating func fillArtifacts(_ artifacts: CardArtifacts?, detail: ConversationDetail?) {
        if let artifacts {
            artifactsCount = artifacts.count
            lastArtifact = artifacts.last?.title
            lastArtifactURL = artifacts.last?.url
            return
        }
        guard let list = detail?.artifacts else { return }
        artifactsCount = list.count
        let newest = list.max { ($0.ts ?? .distantPast) < ($1.ts ?? .distantPast) }
        lastArtifact = newest?.title
        lastArtifactURL = newest?.url
    }
}

/// Une ligne du fil des acceptations, d'où qu'elle vienne (moteur ou détails lus).
struct FeedItem: Identifiable, Equatable {
    let id: String
    let ts: Date?
    let kind: ItemKind
    let title: String
    let detail: String?
    let conversationId: String?
    let conversationTitle: String
    let service: String?

    /// Le fil : celui du moteur, sinon les acceptations des détails déjà lus, fusionnées.
    @MainActor
    static func build(store: VigieStore, limit: Int = 100) -> [FeedItem] {
        let titles = Dictionary(store.conversations.map { ($0.id, $0.shortTitle) }, uniquingKeysWith: { first, _ in first })
        var items: [FeedItem] = []
        if !store.recentAccepted.isEmpty {
            // identifiants tirés de l'élément lui-même : une acceptation qui arrive en tête ne recrée pas les autres lignes
            let rows = RowIDs.make(Array(store.recentAccepted.prefix(limit))) {
                "e|\(RowIDs.stamp($0.ts))|\($0.conversationId ?? "")|\($0.title ?? "")"
            }
            for row in rows {
                let item = row.value
                let name = item.conversationId.flatMap { titles[$0] } ?? item.conversationTitle ?? "Conversation"
                items.append(FeedItem(id: row.id, ts: item.ts, kind: item.itemKind,
                                      title: item.title ?? "Action", detail: item.detail,
                                      conversationId: item.conversationId, conversationTitle: name, service: item.service))
            }
            return items
        }
        for conversation in store.conversations where conversation.isOpen {
            guard let model = store.details[conversation.id] else { continue }
            for row in model.accepted.prefix(limit) {
                let item = row.value
                switch item.decisionKind {
                case .blocked, .waiting, .denied: continue
                case .auto, .you, .unknown: break
                }
                items.append(FeedItem(id: conversation.id + "|" + row.id, ts: item.ts, kind: item.itemKind,
                                      title: item.title ?? "Action", detail: item.detail,
                                      conversationId: conversation.id, conversationTitle: conversation.shortTitle,
                                      service: nil))
            }
        }
        items.sort { ($0.ts ?? .distantPast) > ($1.ts ?? .distantPast) }
        return Array(items.prefix(limit))
    }
}
