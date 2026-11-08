import Foundation
import Testing
@testable import Vigie

/// La liste d'avancée d'un workflow (tuile « Au travail » de la page d'une conversation) : une ligne par étape ou par
/// agent, dans l'ordre fini → en cours → à faire, les étapes à faire venues du plan seulement, et la coupe d'une liste
/// longue.
struct WorkflowProgressTests {
    private static let decoder = JSONDecoder()

    /// Un agent comme le moteur l'envoie. `start` et `last` : minutes après 15:00 le 19 octobre 2026.
    private func agent(_ id: String, step: String? = nil, status: String, phase: String = "Faire", start: Int,
                       last: Int? = nil, workflow: String = "partie-c", title: String? = nil,
                       extra: [String: Any] = [:]) throws -> AgentRun {
        var object: [String: Any] = ["id": id, "status": status, "phase": phase, "workflow": workflow,
                                     "title": title ?? "\(phase.lowercased()):\(step ?? id)",
                                     "startedAt": Self.iso(start), "lastAt": Self.iso(last ?? start + 30)]
        if let step { object["step"] = step }
        object.merge(extra) { _, new in new }
        return try Self.decoder.decode(AgentRun.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private static func iso(_ minutes: Int) -> String {
        ISO8601DateFormatter().string(from: base.addingTimeInterval(Double(minutes) * 60))
    }

    private static let base = ISO8601DateFormatter().date(from: "2026-10-19T15:00:00Z")!

    private func plan(_ steps: [(String, String, String?)], statuses: [String: String] = [:]) throws -> WorkPlan {
        let list = steps.map { id, text, group -> [String: Any] in
            var step: [String: Any] = ["id": id, "text": text, "status": statuses[id] ?? "todo"]
            if let group { step["group"] = group }
            return step
        }
        return try Self.decoder.decode(WorkPlan.self, from: JSONSerialization.data(withJSONObject: ["steps": list]))
    }

    /// Le plan d'Atelier, en plus court : la partie C (L2.19 à L2.25) puis la D.
    private func atelierPlan() throws -> WorkPlan {
        let c = "C. La charte appliquée aux écrans", d = "D. Finitions et publication"
        return try plan([("L2.18", "Chargement", "B. Les composants"),
                         ("L2.19", "Couleurs du thème de nuit", c), ("L2.20", "Titres et typographie", c),
                         ("L2.21", "Écran d'accueil", c), ("L2.22", "Pastilles et boutons", c),
                         ("L2.23", "Jauge de la partie", c), ("L2.24", "Icônes de fin de partie", c),
                         ("L2.25", "Grain de nuit", c), ("L2.26", "Écran des scores", d)],
                        statuses: ["L2.18": "done", "L2.19": "done", "L2.20": "done", "L2.21": "done", "L2.22": "done",
                                   "L2.23": "done", "L2.24": "doing"])
    }

    private func atelierAgents() throws -> [AgentRun] {
        [try agent("ag-24", step: "L2.24", status: "running", start: 482, last: 495),
         try agent("ag-23r", step: "L2.23", status: "running", phase: "Réfuter", start: 478, last: 494),
         try agent("ag-23", step: "L2.23", status: "done", start: 440, last: 477),
         try agent("ag-22r", step: "L2.22", status: "done", phase: "Réfuter", start: 410, last: 436),
         try agent("ag-22", step: "L2.22", status: "done", start: 362, last: 408),
         try agent("ag-21r", step: "L2.21", status: "failed", phase: "Réfuter", start: 330, last: 358),
         try agent("ag-21", step: "L2.21", status: "done", start: 284, last: 328),
         try agent("ag-20", step: "L2.20", status: "done", start: 200, last: 280),
         try agent("ag-19", step: "L2.19", status: "done", start: 22, last: 190)]
    }

    @Test func oneLinePerStepInProgressOrder() throws {
        let progress = WorkflowProgress.make(agents: try atelierAgents(), plan: try atelierPlan(), running: true)
        #expect(progress.items.map(\.title) == ["L2.19 Couleurs du thème de nuit", "L2.20 Titres et typographie",
                                                "L2.21 Écran d'accueil", "L2.22 Pastilles et boutons",
                                                "L2.23 Jauge de la partie", "L2.24 Icônes de fin de partie",
                                                "L2.25 Grain de nuit"])
        #expect(progress.items.map(\.state) == [.done, .done, .failed, .done, .running, .running, .todo])
        // la relecture qui tourne mène sa ligne ; celle qui a échoué après « faire » met la ligne en échec
        #expect(progress.items[4].agent?.id == "ag-23r")
        #expect(progress.items[2].agent?.id == "ag-21r")
        // une étape à faire ne s'ouvre pas ; ni L2.26 (autre partie) ni L2.18 (faite) ne sont « à faire »
        #expect(progress.items[6].agent == nil)
        #expect((progress.done, progress.failed, progress.running, progress.todo) == (3, 1, 2, 1))
        #expect(progress.summary(running: true) == ["3 sur 7 finis", "1 en échec", "2 en cours"])
    }

    @Test func atelierPreviewReadsAsAList() throws {
        let file = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Preview/conversation-b1b9b451-c53c-439e-b804-3689257268e3.json")
        let detail = try Self.decoder.decode(ConversationDetail.self, from: Data(contentsOf: file))
        let model = ConversationDetailModel(detail)
        let workflow = try #require(detail.workflows.first)
        let agents = WorkflowProgress.agents(of: workflow, among: detail.workflows, in: model.runningAgents + model.doneAgents)
        #expect(agents.count == 9)
        let progress = WorkflowProgress.make(agents: agents, plan: detail.now?.plan, running: workflow.status == "running")
        // fini → en cours (L2.24, l'étape en cours du plan) → à faire (L2.25, l'étape suivante)
        #expect(progress.items.map(\.id) == ["étape:L2.19", "étape:L2.20", "étape:L2.21", "étape:L2.22", "étape:L2.23",
                                             "étape:L2.24", "étape:L2.25"])
        #expect(progress.items.last?.state == .todo)
        #expect(progress.items.first { $0.state == .failed }?.title == "L2.21 Écran d'accueil")
        #expect(progress.summary(running: true) == ["3 sur 7 finis", "1 en échec", "2 en cours"])
        // les compteurs du moteur disent la même chose, par agent : 6 finis, 1 en échec, 2 en cours
        #expect(workflow.counts == RunCounts(running: 2, done: 6, failed: 1))
        #expect(progress.shown().hidden == 0)
        // le workflow porte le nom de la partie du plan qu'il fait ; sa demande compte ses 9 agents
        #expect(WorkflowProgress.title(workflow.name ?? workflow.id, agents: agents, plan: detail.now?.plan)
                == "C. La charte appliquée aux écrans")
        #expect(detail.chapters.first?.stats?.agents == 9)
        #expect(workflow.agents == 9)
    }

    @Test func upcomingStepsComeFromThePlanOnly() throws {
        // sans groupe : même préfixe que les étapes prises (« C »), à faire, pas en cours ailleurs
        let steps = try plan([("C1", "Un", nil), ("C2", "Deux", nil), ("C3", "Trois", nil), ("C4", "Quatre", nil),
                              ("C5", "Cinq", nil), ("D1", "Autre partie", nil)],
                             statuses: ["C1": "done", "C3": "doing"])
        let agents = [try agent("a1", step: "C1", status: "done", start: 0), try agent("a2", step: "C2", status: "running", start: 40)]
        let progress = WorkflowProgress.make(agents: agents, plan: steps, running: true)
        #expect(progress.items.map(\.id) == ["étape:C1", "étape:C2", "étape:C4", "étape:C5"])
        #expect(progress.summary(running: true) == ["1 sur 4 fini", "1 en cours"])
        // un workflow qui ne tourne plus n'a rien « à venir »
        #expect(WorkflowProgress.make(agents: agents, plan: steps, running: false).todo == 0)
        // pas de plan, ou des agents sans étape : rien à faire d'inventé
        #expect(WorkflowProgress.make(agents: agents, plan: nil, running: true).todo == 0)
        #expect(WorkflowProgress.prefix("L2.24") == "L2.")
        #expect(WorkflowProgress.prefix("C7") == "C")
        #expect(WorkflowProgress.prefix("12") == nil)
        #expect(WorkflowProgress.prefix("relecture") == nil)
    }

    @Test func agentsWithoutStepEachHaveTheirLine() throws {
        let agents = [try agent("pb-3", status: "running", phase: "Réfuter", start: 50, title: "Relire le contrat"),
                      try agent("pb-1", status: "running", start: 30, title: "types:serveur"),
                      try agent("pb-0", status: "killed", start: 10, title: "Préparer la migration")]
        let progress = WorkflowProgress.make(agents: agents, plan: nil, running: true)
        #expect(progress.items.map(\.title) == ["Préparer la migration", "Agent serveur", "Relire le contrat"])
        #expect(progress.items.map(\.state) == [.stopped, .running, .running])
        // rien de bien fini : les ennuis d'abord, jamais « 0 sur 3 fini »
        #expect(progress.summary(running: true) == ["1 arrêté", "2 en cours"])
    }

    @Test func parallelAgentsOnAStepEachHaveTheirLine() throws {
        // « L3 » faite, puis 4 relecteurs lancés ensemble : 4 lignes en cours, comme « Au travail 4 »
        let steps = try plan([("L2", "Socle", nil), ("L3", "Relecture du lot", nil), ("L4", "Publication", nil)],
                             statuses: ["L2": "done", "L3": "doing"])
        let agents = [try agent("f2", step: "L2", status: "done", start: 0, last: 20),
                      try agent("f3", step: "L3", status: "done", start: 25, last: 50),
                      try agent("r1", step: "L3", status: "running", phase: "Relire", start: 52, title: "Relire L3 côté sécurité"),
                      try agent("r2", step: "L3", status: "running", phase: "Relire", start: 53, title: "Relire L3 côté textes"),
                      try agent("r3", step: "L3", status: "running", phase: "Relire", start: 54, title: "relire:L3"),
                      try agent("r4", step: "L3", status: "running", phase: "Relire", start: 55)]
        let progress = WorkflowProgress.make(agents: agents, plan: steps, running: true)
        #expect(progress.items.map(\.state) == [.done, .running, .running, .running, .running, .todo])
        #expect(progress.items.compactMap { $0.agent?.id } == ["f2", "r1", "r2", "r3", "r4"])
        #expect(Set(progress.items.map(\.id)).count == progress.items.count)
        // chacun par sa description quand elle se lit, sinon par le nom de l'étape
        #expect(progress.items.map(\.title) == ["L2 Socle", "Relire L3 côté sécurité", "Relire L3 côté textes",
                                                "L3 Relecture du lot", "L3 Relecture du lot", "L4 Publication"])
        #expect(progress.running == 4)
        #expect(progress.summary(running: true) == ["1 sur 6 fini", "4 en cours"])
        // un seul qui tourne : une seule ligne, au nom de l'étape, comme avant
        let one = WorkflowProgress.make(agents: Array(agents.prefix(3)), plan: steps, running: true)
        #expect(one.items.map(\.title) == ["L2 Socle", "L3 Relecture du lot", "L4 Publication"])
        #expect(one.items.map(\.id) == ["étape:L2", "étape:L3", "étape:L4"])
    }

    @Test func aFailureStaysUntilARealRelaunch() throws {
        // deux relecteurs ensemble sur S1 : l'un échoue (fin à +10), l'autre finit bien après (+12) ; S2 tourne
        let failed = try agent("a", step: "S1", status: "failed", phase: "Relire", start: 0, last: 10)
        let alongside = try agent("b", step: "S1", status: "done", phase: "Relire", start: 1, last: 12)
        let other = try agent("c", step: "S2", status: "running", start: 15)
        let progress = WorkflowProgress.make(agents: [failed, alongside, other], plan: nil, running: true)
        #expect(progress.items.map(\.state) == [.failed, .running])
        #expect(progress.items.first?.agent?.id == "a")
        #expect(progress.summary(running: true) == ["1 en échec", "1 en cours"])

        // l'autre relecteur tourne encore : la ligne en échec et la sienne, en cours
        let running = try agent("b", step: "S1", status: "running", phase: "Relire", start: 1, last: 12)
        let both = WorkflowProgress.make(agents: [failed, running], plan: nil, running: true)
        #expect(both.items.map(\.state) == [.failed, .running])
        #expect(both.items.map(\.id) == ["étape:S1", "étape:S1#b"])

        // vraie relance (démarrée après la fin de l'échec) : faite si elle a fini, en cours sinon
        let redone = try agent("d", step: "S1", status: "done", start: 15, last: 30)
        let fixed = WorkflowProgress.make(agents: [failed, alongside, redone], plan: nil, running: false)
        #expect(fixed.items.map(\.state) == [.done])
        #expect(fixed.items.first?.agent?.id == "d")
        let retry = try agent("e", step: "S1", status: "running", start: 15)
        #expect(WorkflowProgress.make(agents: [failed, alongside, retry], plan: nil, running: true).items.map(\.state) == [.running])
    }

    @Test func aPlanOfBareNumbersIsOnePart() throws {
        // « ### Task 1 », « ### Task 2 », « ### Task 3 » : ni groupe (le moteur efface le groupe unique) ni préfixe
        let three = try plan([("1", "Modèle", nil), ("2", "Lecture", nil), ("3", "Écran", nil)], statuses: ["1": "done"])
        let started = [try agent("a1", step: "1", status: "done", start: 0), try agent("a2", step: "2", status: "running", start: 40)]
        let progress = WorkflowProgress.make(agents: started, plan: three, running: true)
        #expect(progress.items.map(\.id) == ["étape:1", "étape:2", "étape:3"])
        #expect(progress.items.map(\.state) == [.done, .running, .todo])
        #expect(progress.summary(running: true) == ["1 sur 3 fini", "1 en cours"])

        // ce qui reste vient après la dernière étape prise, dans l'ordre du plan : ni 2 (sautée, avant), ni 5 (faite)
        let six = try plan([("1", "Un", nil), ("2", "Deux", nil), ("3", "Trois", nil), ("4", "Quatre", nil),
                            ("5", "Cinq", nil), ("6", "Six", nil)], statuses: ["1": "done", "3": "doing", "5": "done"])
        let taken = [try agent("b1", step: "1", status: "done", start: 0), try agent("b3", step: "3", status: "running", start: 40)]
        #expect(WorkflowProgress.make(agents: taken, plan: six, running: true).items.map(\.id)
                == ["étape:1", "étape:3", "étape:4", "étape:6"])
        // des groupes dans le plan, mais pas sur ses étapes : rien d'inventé
        let grouped = try plan([("1", "Un", "Partie 1"), ("2", "Deux", nil), ("3", "Trois", nil)])
        #expect(WorkflowProgress.upcoming(steps: grouped.steps, taken: ["2"]).isEmpty)
    }

    @Test func aWorkflowIsNamedAfterItsPartOfThePlan() throws {
        let agents = try atelierAgents()
        let atelier = try atelierPlan()
        #expect(WorkflowProgress.title("partie-c-charte-ecrans", agents: agents, plan: atelier) == "C. La charte appliquée aux écrans")
        // un agent sans étape parmi beaucoup (une synthèse à la fin) ne change pas le nom
        let synthesis = try agent("synthese", status: "running", start: 600, title: "Synthèse de la partie")
        #expect(WorkflowProgress.title("partie-c-charte-ecrans", agents: agents + [synthesis], plan: atelier)
                == "C. La charte appliquée aux écrans")
        // sans plan, des étapes dans deux parties, ou la plupart des agents sans étape : son nom lisible
        #expect(WorkflowProgress.title("partie-c-charte-ecrans", agents: agents, plan: nil) == "Partie C charte ecrans")
        let spread = agents + [try agent("ag-26", step: "L2.26", status: "running", start: 500)]
        #expect(WorkflowProgress.title("partie-c-charte-ecrans", agents: spread, plan: atelier) == "Partie C charte ecrans")
        let loose = [try agent("x1", status: "running", start: 0), try agent("x2", status: "running", start: 1),
                     try agent("x3", step: "L2.24", status: "running", start: 2)]
        #expect(WorkflowProgress.title("revue-securite", agents: loose, plan: atelier) == "Revue securite")
        #expect(WorkflowProgress.title("revue-securite", agents: [], plan: atelier) == "Revue securite")
    }

    @Test func theLatestAttemptSaysHowAStepEnded() throws {
        // refaite après un échec : faite ; relue en échec après avoir été faite : en échec ; arrêtée : arrêtée
        let agents = [try agent("a1", step: "S1", status: "failed", start: 0, last: 20),
                      try agent("a2", step: "S1", status: "done", start: 25, last: 50),
                      try agent("b1", step: "S2", status: "done", start: 60, last: 80),
                      try agent("b2", step: "S2", status: "failed", phase: "Réfuter", start: 85, last: 99),
                      try agent("c1", step: "S3", status: "killed", start: 100, last: 110),
                      try agent("d1", step: "S4", status: "idle", start: 120, last: 130)]
        let progress = WorkflowProgress.make(agents: agents, plan: nil, running: false)
        #expect(progress.items.map(\.state) == [.done, .failed, .stopped, .done])
        #expect(progress.items.map { $0.agent?.id } == ["a2", "b2", "c1", "d1"])
        // sans plan, le nom de l'étape vient de l'agent (« faire:S1 » → « Agent S1 »)
        #expect(progress.items.first?.title == "Agent S1")
        #expect(progress.summary(running: false) == ["2 finis", "1 en échec, 1 arrêté"])
    }

    @Test func aLongListKeepsWhereWeAre() throws {
        // 12 finis (dont 1 en échec, parmi les plus anciens), 2 en cours, 6 à faire
        var agents: [AgentRun] = []
        for index in 1...12 {
            agents.append(try agent("f\(index)", step: "S\(index)", status: index == 2 ? "failed" : "done", start: index * 10))
        }
        agents.append(try agent("r13", step: "S13", status: "running", start: 200))
        agents.append(try agent("r14", step: "S14", status: "running", start: 210))
        let steps = try plan((1...20).map { ("S\($0)", "Étape \($0)", "Partie S") },
                             statuses: Dictionary(uniqueKeysWithValues: (1...12).map { ("S\($0)", "done") }))
        let progress = WorkflowProgress.make(agents: agents, plan: steps, running: true)
        #expect(progress.items.count == 20)
        #expect(progress.summary(running: true) == ["11 sur 20 finis", "1 en échec", "2 en cours"])

        let shown = progress.shown()
        #expect(shown.items.map(\.id) == ["étape:S10", "étape:S11", "étape:S12", "étape:S13", "étape:S14",
                                          "étape:S15", "étape:S16", "étape:S17"])
        #expect(shown.earlierFinished == 9)
        #expect(shown.earlierFailed == 1)
        #expect(shown.laterTodo == 3)
        #expect(shown.hidden == 12)
        // « Tout afficher » : tout, sans rien compter à part
        let all = progress.shown(all: true)
        #expect(all.items.count == 20)
        #expect(all.hidden == 0)
    }

    @Test func aShortListShowsEverything() throws {
        let agents = (1...8).map { index in try? agent("a\(index)", step: "S\(index)", status: "done", start: index * 10) }
            .compactMap { $0 }
        let progress = WorkflowProgress.make(agents: agents, plan: nil, running: true)
        let shown = progress.shown()
        #expect(shown.items.count == 8)
        #expect((shown.earlierFinished, shown.laterTodo, shown.hidden) == (0, 0, 0))
    }

    @Test func summaryBeforeAnythingEnds() throws {
        let steps = try plan([("S1", "Un", "P"), ("S2", "Deux", "P"), ("S3", "Trois", "P"), ("S4", "Quatre", "P")])
        let agents = [try agent("a1", step: "S1", status: "running", start: 0), try agent("a2", step: "S2", status: "running", start: 1)]
        let progress = WorkflowProgress.make(agents: agents, plan: steps, running: true)
        #expect(progress.summary(running: true) == ["2 en cours", "2 à venir"])
        #expect(WorkflowProgress.make(agents: [], plan: steps, running: true).summary(running: true).isEmpty)
    }

    @Test func remainingTimeIsRoundedAndHonest() throws {
        let now = Self.base.addingTimeInterval(500 * 60)
        let soon = try agent("a1", step: "S1", status: "running", start: 482,
                             extra: ["estimate": ["medianMs": 2_760_000, "basis": 5, "endsAt": Self.iso(541), "longer": false]])
        #expect(WorkflowProgress.remaining(soon, now: now) == "reste ≈ 40 min")
        let late = try agent("a2", step: "S2", status: "running", start: 400,
                             extra: ["estimate": ["medianMs": 600_000, "basis": 3, "endsAt": Self.iso(420), "longer": true]])
        #expect(WorkflowProgress.remaining(late, now: now) == "plus long que les autres")
        // moins de 3 agents finis dans sa phase : pas d'estimation, rien d'affiché
        #expect(WorkflowProgress.remaining(try agent("a3", status: "running", start: 490), now: now) == nil)
    }

    @Test func aRelaunchKeepsItsOwnAgents() throws {
        let first = try Self.decoder.decode(Workflow.self, from: Data(#"{"id": "w1", "name": "revue", "status": "failed", "startedAt": "\#(Self.iso(0))"}"#.utf8))
        let second = try Self.decoder.decode(Workflow.self, from: Data(#"{"id": "w2", "name": "revue", "status": "running", "startedAt": "\#(Self.iso(100))"}"#.utf8))
        let agents = [try agent("old", status: "failed", start: 10, workflow: "revue"),
                      try agent("new", status: "running", start: 110, workflow: "revue"),
                      try agent("other", status: "running", start: 120, workflow: "autre")]
        #expect(WorkflowProgress.agents(of: first, among: [second, first], in: agents).map(\.id) == ["old"])
        #expect(WorkflowProgress.agents(of: second, among: [second, first], in: agents).map(\.id) == ["new"])
        // un seul lancement : tous ceux qui portent son nom
        #expect(WorkflowProgress.agents(of: second, among: [second], in: agents).map(\.id) == ["old", "new"])
    }
}
