import Foundation

/// L'avancée d'un workflow en liste, pour sa tuile de « Au travail » (page d'une conversation) : une règle pure,
/// testée, sans vue.
///
/// Une ligne par étape du plan que ses agents ont prise (celui qui la fait et celui qui la relit réunis sur la même
/// ligne), ou par agent sans étape ; puis, tant qu'il tourne, les étapes du plan pas encore commencées de la même
/// partie (même groupe du plan, sinon même préfixe : « L2. », « C »). Rien d'inventé : une ligne « à faire » vient
/// toujours du plan, jamais d'un total supposé.
///
/// Ordre : ce qui est fini, du plus ancien au plus récent ; ce qui tourne ; puis ce qui reste, dans l'ordre du plan.
struct WorkflowProgress: Equatable, Sendable {
    enum State: Equatable, Sendable {
        case done, failed, stopped, running, todo

        /// Fini, bien ou mal.
        var isFinished: Bool { self == .done || self == .failed || self == .stopped }
    }

    struct Item: Equatable, Sendable, Identifiable {
        /// « étape:L2.24 » ou « agent:ag-7 ».
        let id: String
        /// « L2.24 Icônes de fin de partie » ; pour un agent sans étape, son nom lisible.
        let title: String
        let state: State
        /// L'agent qui dit l'état de la ligne : celui qui tourne, sinon le dernier fini. Un clic l'ouvre. nil pour une
        /// étape à faire.
        let agent: AgentRun?
        /// Début de son premier agent.
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
            guard let group = groups[key], let item = item(key: key, group: group, steps: steps) else { continue }
            if item.state == .running { live.append(item) } else { finished.append(item) }
        }
        // du plus ancien au plus récent ; à égalité, l'ordre du plan
        let order = { (item: Item) -> (Date, Int) in
            (item.startedAt ?? .distantPast, item.agent.flatMap(stepID).flatMap { planIndex[$0] } ?? Int.max)
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

    /// Une ligne : l'agent qui tourne la mène ; sinon le dernier fini dit comment elle a fini (un agent qui relit et
    /// échoue après celui qui a fait : la ligne est en échec).
    private static func item(key: String, group: [AgentRun], steps: [PlanStep]) -> Item? {
        let byStart = group.sorted { ($0.startedAt ?? .distantPast) < ($1.startedAt ?? .distantPast) }
        let lead: AgentRun
        let state: State
        if let live = byStart.last(where: { $0.status == "running" }) {
            lead = live
            state = .running
        } else if let last = byStart.max(by: { ($0.lastAt ?? $0.startedAt ?? .distantPast) < ($1.lastAt ?? $1.startedAt ?? .distantPast) }) {
            lead = last
            switch last.status {
            case "failed": state = .failed
            case "killed": state = .stopped
            default: state = .done // fini, ou sans fin connue (« idle »), compté fini comme dans le moteur
            }
        } else {
            return nil
        }
        let step = stepID(lead).flatMap { id in steps.first { $0.id == id } }
        let title = step.map(\.label).flatMap { $0.isEmpty ? nil : $0 }
            ?? Fmt.agentTitle(name: lead.name, title: lead.title, id: lead.id, planSteps: steps)
        return Item(id: key, title: title, state: state, agent: lead, startedAt: byStart.first?.startedAt)
    }

    /// Les étapes du plan encore à faire de la partie que le workflow traite : même groupe que ses étapes, sinon même
    /// préfixe d'identifiant ; ni faites, ni en cours ailleurs, ni déjà prises par un de ses agents.
    static func upcoming(steps: [PlanStep], taken: Set<String>) -> [PlanStep] {
        guard !taken.isEmpty else { return [] }
        let mine = steps.filter { $0.id.map(taken.contains) ?? false }
        let groups = Set(mine.compactMap { $0.group?.isEmpty == false ? $0.group : nil })
        let prefixes = Set(taken.compactMap(prefix))
        return steps.filter { step in
            guard step.state == .todo, let id = step.id, !taken.contains(id) else { return false }
            if !groups.isEmpty { return step.group.map(groups.contains) ?? false }
            return prefix(id).map(prefixes.contains) ?? false
        }
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

    /// En tête de la tuile, 3 infos au plus. En cours : « 3 sur 7 finis · 1 en échec · 2 en cours » ; rien de fini
    /// encore : « 2 en cours · 5 à venir ». Workflow terminé : « 6 finis · 1 en échec ».
    func summary(running: Bool) -> [String] {
        guard !items.isEmpty else { return [] }
        let trouble = [failed > 0 ? "\(Fmt.int(failed)) en échec" : nil,
                       stopped > 0 ? Fmt.count(stopped, "arrêté") : nil].compactMap { $0 }.joined(separator: ", ")
        guard running else {
            return [done > 0 ? Fmt.count(done, "fini", "finis") : nil, trouble.isEmpty ? nil : trouble].compactMap { $0 }
        }
        if done + failed + stopped == 0 {
            return [self.running > 0 ? "\(Fmt.int(self.running)) en cours" : nil,
                    todo > 0 ? "\(Fmt.int(todo)) à venir" : nil].compactMap { $0 }
        }
        return ["\(Fmt.int(done)) sur \(Fmt.int(items.count)) \(done > 1 ? "finis" : "fini")",
                trouble.isEmpty ? nil : trouble,
                self.running > 0 ? "\(Fmt.int(self.running)) en cours" : nil].compactMap { $0 }
    }

    /// Ce qu'il reste à un agent qui tourne : « reste ≈ 40 min » (par 5 min, 5 au moins), ou « plus long que les
    /// autres » une fois l'estimation dépassée ; nil sans estimation (moins de 3 agents finis dans sa phase).
    static func remaining(_ agent: AgentRun, now: Date) -> String? {
        guard agent.status == "running", let estimate = agent.estimate, let ends = estimate.endsAt else { return nil }
        if estimate.longer == true || ends <= now { return "plus long que les autres" }
        let minutes = max(5, Int((ends.timeIntervalSince(now) / 60 / 5).rounded()) * 5)
        return "reste ≈ \(Fmt.duration(ms: Double(minutes) * 60_000))"
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
