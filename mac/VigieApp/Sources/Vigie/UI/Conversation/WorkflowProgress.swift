import Foundation

/// L'avancée d'un workflow en liste, pour sa tuile de « Au travail » (page d'une conversation) : une règle pure,
/// testée, sans vue.
///
/// Une ligne par étape du plan que ses agents ont prise (celui qui la fait et celui qui la relit réunis sur la même
/// ligne), ou par agent sans étape. Plusieurs agents qui tournent en même temps sur une étape (des relecteurs en
/// parallèle) ont chacun leur ligne ; un échec garde la sienne tant qu'aucun agent de l'étape n'a démarré après lui
/// (une vraie relance). Puis, tant qu'il tourne, les étapes du plan pas encore commencées de la même partie (même
/// groupe du plan, sinon même préfixe : « L2. », « C » ; un plan sans l'un ni l'autre est une seule partie). Rien
/// d'inventé : une ligne « à faire » vient toujours du plan, jamais d'un total supposé.
///
/// Ordre : ce qui est fini, du plus ancien au plus récent ; ce qui tourne ; puis ce qui reste, dans l'ordre du plan.
struct WorkflowProgress: Equatable, Sendable {
    enum State: Equatable, Sendable {
        case done, failed, stopped, running, todo

        /// Fini, bien ou mal.
        var isFinished: Bool { self == .done || self == .failed || self == .stopped }
    }

    struct Item: Equatable, Sendable, Identifiable {
        /// « étape:L2.24 » ou « agent:ag-7 » ; une ligne de plus sur la même étape : « étape:L3#ag-9 ».
        let id: String
        /// « L2.24 Icônes de fin de partie » ; pour un agent sans étape, son nom lisible.
        let title: String
        let state: State
        /// L'agent qui dit l'état de la ligne : celui qui tourne, sinon celui qui a échoué, sinon le dernier fini. Un
        /// clic l'ouvre. nil pour une étape à faire.
        let agent: AgentRun?
        /// Début du premier agent de son étape (toutes les lignes d'une étape restent ensemble).
        let startedAt: Date?
    }

    let items: [Item]

    var done: Int { items.count { $0.state == .done } }
    var failed: Int { items.count { $0.state == .failed } }
    var stopped: Int { items.count { $0.state == .stopped } }
    var running: Int { items.count { $0.state == .running } }
    var todo: Int { items.count { $0.state == .todo } }

    // MARK: Construction

    /// `agents` : ceux du workflow (`agents(of:among:in:)`), en cours et finis. `running` : le workflow tourne encore
    /// (seulement alors les étapes du plan qui restent sont « à faire » pour lui).
    static func make(agents: [AgentRun], plan: WorkPlan?, running: Bool) -> WorkflowProgress {
        let steps = plan?.steps ?? []
        let planIndex = Dictionary(steps.enumerated().compactMap { offset, step in step.id.map { ($0, offset) } },
                                   uniquingKeysWith: { first, _ in first })

        // les agents réunis par étape (dans l'ordre où on les rencontre), un agent sans étape seul
        var keys: [String] = []
        var groups: [String: [AgentRun]] = [:]
        for agent in agents {
            let key = stepID(agent).map { "étape:\($0)" } ?? "agent:\(agent.id)"
            if groups[key] == nil { keys.append(key) }
            groups[key, default: []].append(agent)
        }

        var finished: [Item] = [], live: [Item] = []
        for key in keys {
            guard let group = groups[key] else { continue }
            for item in items(key: key, group: group, steps: steps) {
                if item.state == .running { live.append(item) } else { finished.append(item) }
            }
        }
        // du plus ancien au plus récent ; à égalité, l'ordre du plan, puis le début de son agent
        let order = { (item: Item) -> (Date, Int, Date) in
            (item.startedAt ?? .distantPast, item.agent.flatMap(stepID).flatMap { planIndex[$0] } ?? Int.max,
             item.agent?.startedAt ?? .distantPast)
        }
        finished.sort { order($0) < order($1) }
        live.sort { order($0) < order($1) }

        var todo: [Item] = []
        if running {
            let taken = Set(agents.compactMap(stepID))
            todo = upcoming(steps: steps, taken: taken).map {
                Item(id: "étape:\($0.id ?? $0.label)", title: $0.label, state: .todo, agent: nil, startedAt: nil)
            }
        }
        return WorkflowProgress(items: finished + live + todo)
    }

    /// L'étape du plan d'un agent (« L2.24 »), donnée par le moteur.
    static func stepID(_ agent: AgentRun) -> String? {
        guard let step = agent.step?.trimmingCharacters(in: .whitespaces), !step.isEmpty else { return nil }
        return step
    }

    /// Les lignes d'une étape (ou d'un agent sans étape) :
    /// - une par agent qui tourne : des relecteurs lancés ensemble ont chacun la leur, avec ce qu'il fait ;
    /// - une « en échec » (sinon « arrêté ») tant qu'aucun agent de l'étape n'a démarré après la fin de celui qui a mal
    ///   fini : une vraie relance l'efface, un agent qui tournait déjà à côté et finit bien, non ;
    /// - sinon, rien ne tourne : une ligne finie, menée par le dernier agent fini.
    private static func items(key: String, group: [AgentRun], steps: [PlanStep]) -> [Item] {
        let byStart = group.sorted { ($0.startedAt ?? .distantPast) < ($1.startedAt ?? .distantPast) }
        guard let first = byStart.first else { return [] }
        let live = byStart.filter { $0.status == "running" }
        let unresolved = byStart.filter { agent in
            (agent.status == "failed" || agent.status == "killed")
                && !byStart.contains { $0.id != agent.id && ($0.startedAt ?? .distantPast) > end(agent) }
        }
        let latest = { (a: AgentRun, b: AgentRun) in end(a) < end(b) }

        var rows: [(agent: AgentRun, state: State)] = []
        if let failure = unresolved.filter({ $0.status == "failed" }).max(by: latest) {
            rows.append((failure, .failed))
        } else if let stop = unresolved.max(by: latest) {
            rows.append((stop, .stopped))
        }
        rows += live.map { ($0, .running) }
        if rows.isEmpty, let last = byStart.max(by: latest) {
            // fini, ou sans fin connue (« idle »), compté fini comme dans le moteur
            rows.append((last, .done))
        }

        let label = stepID(first).flatMap { id in steps.first { $0.id == id } }.map(\.label).flatMap { $0.isEmpty ? nil : $0 }
        return rows.enumerated().map { offset, row in
            var title = label ?? Fmt.agentTitle(name: row.agent.name, title: row.agent.title, id: row.agent.id, planSteps: steps)
            // plusieurs à la fois sur l'étape : chacun par sa description quand elle se lit (« Relire L3 côté
            // sécurité ») ; un identifiant (« refuter:L3 ») garde le nom de l'étape
            if live.count > 1, row.state == .running,
               let own = row.agent.title?.trimmingCharacters(in: .whitespaces), own.contains(where: \.isWhitespace) {
                title = own
            }
            return Item(id: offset == 0 ? key : "\(key)#\(row.agent.id)", title: title, state: row.state,
                        agent: row.agent, startedAt: first.startedAt)
        }
    }

    /// La fin d'un agent : son dernier signe de vie, sinon son début.
    private static func end(_ agent: AgentRun) -> Date {
        agent.lastAt ?? agent.startedAt ?? .distantPast
    }

    /// Les étapes du plan encore à faire de la partie que le workflow traite : même groupe que ses étapes, sinon même
    /// préfixe d'identifiant ; ni faites, ni en cours ailleurs, ni déjà prises par un de ses agents. Un plan sans
    /// groupe dont les étapes n'ont que des numéros (« ### Task 3 » : le moteur efface le groupe unique d'un plan) est
    /// une seule partie : ce qui reste vient après la dernière étape prise, dans l'ordre du plan.
    static func upcoming(steps: [PlanStep], taken: Set<String>) -> [PlanStep] {
        guard !taken.isEmpty else { return [] }
        let mine = steps.filter { $0.id.map(taken.contains) ?? false }
        let groups = Set(mine.compactMap { $0.group?.isEmpty == false ? $0.group : nil })
        let prefixes = Set(taken.compactMap(prefix))
        let open = { (step: PlanStep) -> Bool in
            guard step.state == .todo, let id = step.id else { return false }
            return !taken.contains(id)
        }
        if !groups.isEmpty {
            return steps.filter { open($0) && ($0.group.map(groups.contains) ?? false) }
        }
        if !prefixes.isEmpty {
            return steps.filter { open($0) && ($0.id.flatMap(prefix).map(prefixes.contains) ?? false) }
        }
        guard steps.allSatisfy({ $0.group?.isEmpty ?? true }),
              let last = steps.lastIndex(where: { $0.id.map(taken.contains) ?? false }) else { return [] }
        return steps[(last + 1)...].filter(open)
    }

    /// « L2.24 » → « L2. », « C7 » → « C » ; sans chiffre à la fin, ou rien devant : pas de préfixe.
    static func prefix(_ id: String) -> String? {
        let head = id.replacing(/\d+$/, with: "")
        return head.isEmpty || head == id ? nil : head
    }

    // MARK: Liste longue

    /// Ce qu'on montre d'une liste longue : les derniers finis, ce qui tourne, les prochains à faire ; le reste se
    /// compte (« 12 autres finis, dont 1 en échec », « 5 autres à venir ») et « Tout afficher » déplie tout.
    struct Shown: Equatable, Sendable {
        let items: [Item]
        /// Finis plus tôt, pas montrés, et combien d'entre eux en échec.
        let earlierFinished: Int
        let earlierFailed: Int
        /// À faire plus tard, pas montrés.
        let laterTodo: Int
        /// Lignes cachées en tout (y compris des agents en cours au-delà de la limite).
        let hidden: Int
    }

    /// Jusqu'à 8 lignes, tout se montre.
    static let fullList = 8
    static let lastFinished = 3
    static let maxRunning = 5
    static let nextTodo = 3

    func shown(all: Bool = false) -> Shown {
        guard !all, items.count > Self.fullList else {
            return Shown(items: items, earlierFinished: 0, earlierFailed: 0, laterTodo: 0, hidden: 0)
        }
        let finished = items.filter(\.state.isFinished)
        let keptFinished = finished.suffix(Self.lastFinished)
        let earlier = finished.dropLast(Self.lastFinished)
        let live = items.filter { $0.state == .running }.prefix(Self.maxRunning)
        let todo = items.filter { $0.state == .todo }
        let list = Array(keptFinished) + Array(live) + Array(todo.prefix(Self.nextTodo))
        return Shown(items: list, earlierFinished: earlier.count, earlierFailed: earlier.count { $0.state == .failed },
                     laterTodo: max(0, todo.count - Self.nextTodo), hidden: items.count - list.count)
    }

    // MARK: Textes

    /// En tête de la tuile, 3 infos au plus, comptées sur les lignes de la liste. En cours : « 3 sur 7 finis · 1 en
    /// échec · 2 en cours » ; rien de bien fini encore : les ennuis d'abord, puis ce qui tourne et ce qui vient
    /// (« 1 arrêté · 2 en cours · 5 à venir »), jamais « 0 sur 3 fini ». Workflow terminé : « 6 finis · 1 en échec ».
    func summary(running: Bool) -> [String] {
        guard !items.isEmpty else { return [] }
        let trouble = [failed > 0 ? "\(Fmt.int(failed)) en échec" : nil,
                       stopped > 0 ? Fmt.count(stopped, "arrêté") : nil].compactMap { $0 }.joined(separator: ", ")
        let problems = trouble.isEmpty ? nil : trouble
        guard running else {
            return [done > 0 ? Fmt.count(done, "fini", "finis") : nil, problems].compactMap { $0 }
        }
        let live = self.running > 0 ? "\(Fmt.int(self.running)) en cours" : nil
        if done == 0 {
            return [problems, live, todo > 0 ? "\(Fmt.int(todo)) à venir" : nil].compactMap { $0 }
        }
        return ["\(Fmt.int(done)) sur \(Fmt.int(items.count)) \(done > 1 ? "finis" : "fini")", problems, live].compactMap { $0 }
    }

    /// Ce qu'il reste à un agent qui tourne : « reste ≈ 40 min » (par 5 min, 5 au moins), ou « plus long que les
    /// autres » une fois l'estimation dépassée ; nil sans estimation (moins de 3 agents finis dans sa phase).
    static func remaining(_ agent: AgentRun, now: Date) -> String? {
        guard agent.status == "running", let estimate = agent.estimate, let ends = estimate.endsAt else { return nil }
        if estimate.longer == true || ends <= now { return "plus long que les autres" }
        let minutes = max(5, Int((ends.timeIntervalSince(now) / 60 / 5).rounded()) * 5)
        return "reste ≈ \(Fmt.duration(ms: Double(minutes) * 60_000))"
    }

    /// Le nom d'un workflow à l'écran : le titre de la partie du plan où travaillent ses agents (« C. La charte
    /// appliquée aux écrans ») quand la plupart font une étape du plan et que toutes ces étapes sont dans la même
    /// partie ; sinon son nom lisible (« Partie C charte ecrans »). `raw` : son nom brut, qui va en `.help`.
    static func title(_ raw: String, agents: [AgentRun], plan: WorkPlan?) -> String {
        let steps = plan?.steps ?? []
        let placed = agents.compactMap { agent in stepID(agent).flatMap { id in steps.first { $0.id == id } } }
        let groups = Set(placed.map { $0.group?.trimmingCharacters(in: .whitespaces) ?? "" })
        guard placed.count * 2 > agents.count, groups.count == 1, let group = groups.first, !group.isEmpty else {
            return Fmt.workflowTitle(raw)
        }
        return group
    }

    /// Les agents d'un workflow : ceux qui portent son nom. Quand plusieurs lancements portent le même nom (une
    /// relance), chaque agent va au dernier lancé avant lui.
    static func agents(of workflow: Workflow, among workflows: [Workflow], in agents: [AgentRun]) -> [AgentRun] {
        let name = workflow.name ?? workflow.id
        let mine = agents.filter { $0.workflow == name }
        let same = workflows.filter { ($0.name ?? $0.id) == name }
        guard same.count > 1 else { return mine }
        let launches = same.sorted { ($0.startedAt ?? .distantPast) < ($1.startedAt ?? .distantPast) }
        return mine.filter { agent in
            let start = agent.startedAt ?? .distantFuture
            let owner = launches.last { ($0.startedAt ?? .distantPast) <= start } ?? launches.first
            return owner?.id == workflow.id
        }
    }
}
