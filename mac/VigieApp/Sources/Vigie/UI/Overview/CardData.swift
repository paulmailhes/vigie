import Foundation

/// Ce qu'affiche la carte d'une conversation : les champs du moteur, sinon calculés depuis le détail.
struct CardData: Equatable {
    struct Failure: Equatable {
        var title: String
        var line: String?
    }

    var progressDone = 0
    var progressTotal = 0
    /// Le titre du plan suivi (« Tâches » quand le chiffre vient de la liste de tâches).
    var progressLabel: String?
    /// L'avancée compte les tâches de la liste, pas les étapes d'un plan.
    var progressFromTasks = false
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

    /// L'aide de la colonne « Avancée » : d'où vient « 23/31 » (« 23 étapes faites sur 31 du plan « Refonte » »,
    /// « 3 tâches faites sur 5 »).
    var progressHelp: String {
        guard hasProgress else { return "" }
        if progressFromTasks {
            return "\(Fmt.count(progressDone, "tâche faite", "tâches faites")) sur \(Fmt.int(progressTotal))"
        }
        let steps = "\(Fmt.count(progressDone, "étape faite", "étapes faites")) sur \(Fmt.int(progressTotal))"
        guard let label = progressLabel, !label.isEmpty else { return "\(steps) du plan" }
        return "\(steps) du plan « \(label) »"
    }

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
            // le moteur nomme « Tâches » une avancée tirée de la liste de tâches (sans plan)
            progressFromTasks = progress.label == "Tâches"
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
            progressFromTasks = true
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
            case .expectedFail, .unknown:
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
