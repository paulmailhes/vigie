import SwiftUI

/// Une petite tuile : un surtitre qui dit ce qu'elle montre (« Plan », « Tests »), son chiffre à droite, puis
/// quelques lignes. Un clic ouvre le détail.
struct SmallTile<Content: View>: View {
    var title: String
    var trailing: String?
    var tone: ConversationVerdict.Tone = .calm
    var action: (() -> Void)?
    @ViewBuilder var content: Content

    var body: some View {
        let tile = VStack(alignment: .leading, spacing: 6) {
            CardTitle(title, trailing: trailing, alert: tone == .alert)
            VStack(alignment: .leading, spacing: 4) {
                content
            }
        }
        .font(.callout)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tone == .alert ? AnyShapeStyle(Theme.alert.opacity(0.08)) : AnyShapeStyle(.quinary), in: .rect(cornerRadius: Theme.corner))
        if let action {
            Button(action: action) { tile }
                .buttonStyle(TileButtonStyle(cornerRadius: Theme.corner))
        } else {
            tile
        }
    }
}

/// La colonne de côté : deux tuiles au plus, ce qui cloche d'abord (tests en échec, commande de fond), puis le plan
/// (sinon les tâches, sinon la feuille de route), puis ce qui a été publié.
struct SideTiles: View {
    @Environment(VigieStore.self) private var store
    let model: ConversationDetailModel
    let open: (ConversationPanel) -> Void

    enum Kind: Hashable { case tests, commands, plan, tasks, roadmap, published }

    var body: some View {
        VStack(spacing: 10) {
            ForEach(Self.kinds(model, now: store.now).prefix(2), id: \.self) { kind in
                tile(kind)
            }
        }
    }

    static func kinds(_ model: ConversationDetailModel, now: Date) -> [Kind] {
        var list: [Kind] = []
        if redTest(model, now: now) != nil { list.append(.tests) }
        if !commands(model, now: now).isEmpty { list.append(.commands) }
        let detail = model.raw
        if let plan = detail.now?.plan, !plan.steps.isEmpty,
           plan.doneCount < plan.totalCount || now.timeIntervalSince(plan.updatedAt ?? .distantPast) < 3600 {
            list.append(.plan)
        } else if let tasks = detail.now?.tasks, !tasks.isEmpty, tasks.contains(where: { $0.state != .done }) {
            list.append(.tasks)
        } else if let doc = detail.trackingDoc, now.timeIntervalSince(doc.updatedAt ?? .distantPast) < 86_400 {
            list.append(.roadmap)
        }
        if published(model, now: now) != nil { list.append(.published) }
        return list
    }

    /// Le dernier test : en échec depuis moins de 2 h, sans réussite depuis.
    static func redTest(_ model: ConversationDetailModel, now: Date) -> TestRun? {
        guard let last = model.tests.map(\.value).first(where: { $0.outcome != .pending && $0.outcome != .unknown }),
              last.outcome == .failed, now.timeIntervalSince(last.ts ?? .distantPast) < 7200 else { return nil }
        return last
    }

    /// Une commande de fond qui tourne depuis plus d'une minute.
    static func commands(_ model: ConversationDetailModel, now: Date) -> [BackgroundCommand] {
        model.raw.background.filter { now.timeIntervalSince($0.startedAt ?? now) > 60 }
    }

    static func published(_ model: ConversationDetailModel, now: Date) -> Artifact? {
        let start = model.raw.current?.start ?? .distantPast
        return model.artifacts.map(\.value).first { ($0.ts ?? .distantPast) >= start && now.timeIntervalSince($0.ts ?? .distantPast) < 7200 }
    }

    @ViewBuilder
    private func tile(_ kind: Kind) -> some View {
        let detail = model.raw
        let now = store.now
        switch kind {
        case .tests:
            if let test = Self.redTest(model, now: now) {
                SmallTile(title: failedTitle(test), trailing: test.ts.map { "depuis \(Fmt.when($0, now: now))" }, tone: .alert,
                          action: { open(.tests) }) {
                    Text(test.title ?? "Tests").lineLimit(1)
                    if let line = test.line, !line.isEmpty {
                        CodeLine(line)
                    }
                    if let by = test.by { Text("Par \(by)").foregroundStyle(.secondary).lineLimit(1) }
                }
            }
        case .commands:
            let list = Self.commands(model, now: now)
            if let first = list.first {
                SmallTile(title: "Commande de fond", trailing: first.startedAt.map { "depuis \(Fmt.age(since: $0, now: now))" },
                          action: { open(.background) }) {
                    Text(first.description ?? "Commande").lineLimit(1)
                    if let command = first.command {
                        CodeLine(command)
                    }
                    if list.count > 1 { Text("+\(list.count - 1) autres").foregroundStyle(.secondary) }
                }
            }
        case .plan:
            if let plan = detail.now?.plan {
                // le surtitre dit ce que c'est ; le nom du plan est sa première ligne
                SmallTile(title: "Plan", trailing: "\(plan.doneCount)/\(plan.totalCount) étapes", action: { open(.plan) }) {
                    if let name = plan.title.map(Self.cleanTitle), !name.isEmpty {
                        Text(name)
                            .textRole(.item)
                            .lineLimit(1)
                            .help(plan.file.map(Fmt.shortPath) ?? name)
                    }
                    ProgressView(value: Double(min(plan.doneCount, plan.totalCount)), total: Double(max(plan.totalCount, 1)))
                        .progressViewStyle(.linear)
                        .tint(.secondary)
                        .accessibilityLabel("\(plan.doneCount) étapes faites sur \(plan.totalCount)")
                    if let index = plan.currentIndex {
                        Text("▸ \(plan.steps[index].label)").lineLimit(1)
                        if let next = plan.steps.dropFirst(index + 1).first(where: { $0.state != .done }) {
                            Text("Ensuite : \(next.label)").foregroundStyle(.secondary).lineLimit(1)
                        }
                    } else if plan.doneCount >= plan.totalCount {
                        let end = plan.progressAt ?? plan.updatedAt
                        Text(end.map { "Fini \(ConversationVerdict.at($0, now: now))" } ?? "Fini")
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                    if let task = detail.now?.tasks.first(where: { $0.state == .doing })?.text {
                        let tasks = detail.now?.tasks ?? []
                        Text("Tâches \(tasks.count { $0.state == .done })/\(tasks.count) · \(task)")
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                            .lineLimit(1)
                    }
                }
            }
        case .tasks:
            let tasks = detail.now?.tasks ?? []
            SmallTile(title: "Tâches", trailing: "\(tasks.count { $0.state == .done })/\(tasks.count)", action: { open(.plan) }) {
                if let doing = tasks.first(where: { $0.state == .doing }) ?? tasks.first(where: { $0.state == .todo }) {
                    Text("▸ \(doing.text ?? "")").lineLimit(2)
                }
            }
        case .roadmap:
            if let doc = detail.trackingDoc {
                SmallTile(title: "Feuille de route", trailing: doc.updatedAt.map { Fmt.when($0, now: now) }, action: { open(.plan) }) {
                    Text((doc.path as NSString).lastPathComponent)
                        .textRole(.item)
                        .lineLimit(1)
                        .help(Fmt.shortPath(doc.path))
                    let line = Self.roadmapLine(doc)
                    if !line.isEmpty {
                        Text(line).lineLimit(2).foregroundStyle(.secondary)
                    }
                }
            }
        case .published:
            if let artifact = Self.published(model, now: now) {
                SmallTile(title: "Publié", trailing: artifact.ts.map { Fmt.when($0, now: now) }) {
                    let name = artifact.title ?? "Page publiée"
                    if let link = Self.webLink(artifact.url) {
                        // le bouton passe sous le titre quand la colonne est étroite
                        ViewThatFits(in: .horizontal) {
                            HStack {
                                Text(name).lineLimit(1)
                                Spacer(minLength: 6)
                                openButton(link)
                            }
                            VStack(alignment: .leading, spacing: 6) {
                                Text(name).lineLimit(2)
                                openButton(link)
                            }
                        }
                    } else {
                        Text(name).lineLimit(2)
                    }
                }
            }
        }
    }

    private func openButton(_ link: String) -> some View {
        Button("Ouvrir dans ton navigateur") { SystemActions.open(link) }
            .glassButton()
            .fixedSize()
            .help(link)
    }

    /// Une adresse web (http, https) ; un autre schéma, venu d'un agent, ne s'ouvre pas.
    static func webLink(_ url: String?) -> String? {
        guard let url, let scheme = URL(string: url)?.scheme?.lowercased(), ["http", "https"].contains(scheme) else { return nil }
        return url
    }

    private func failedTitle(_ test: TestRun) -> String {
        if let failed = test.failed, failed > 0 { return Fmt.count(failed, "test en échec", "tests en échec") }
        return "Tests en échec"
    }

    /// « # Plan : Livre, lot 6 » → « Livre, lot 6 » : sans les # ni le « Plan : ».
    static func cleanTitle(_ title: String) -> String {
        title.replacing(/^#+\s*/, with: "").replacing(/^[Pp]lan\s*:\s*/, with: "")
            .trimmingCharacters(in: .whitespaces)
    }

    /// La 1re phrase de « où on en est » (ou de son introduction).
    static func roadmapLine(_ doc: TrackingDoc) -> String {
        let key = /(où on en est|ou on en est|état|etat|statut|en cours|suite)/.ignoresCase()
        let text = doc.sections.first { $0.title.contains(key) }?.text ?? doc.intro ?? doc.sections.first?.text ?? ""
        let line = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty && !$0.hasPrefix("#") } ?? ""
        return String(line.replacing(/^[-*>\s]+/, with: "").prefix(140))
    }
}

// MARK: Au travail : workflows et agents

/// Un agent, en 4 lignes : nom lisible (l'étape du plan), sa phase et ce qu'on lui a demandé, ce qu'il fait (ou ce
/// qu'il a rendu), depuis quand et, quand c'est honnête, combien il lui reste. Une barre de 3 pt à gauche dit son état
/// (vert en cours, orange muet, rouge en échec, gris fini).
struct AgentTile: View {
    enum Look: Sendable {
        /// Un agent seul, posé sur la page : une carte.
        case card
        /// Dans une liste déjà posée sur un fond : ni fond ni contour, la barre seule.
        case row
    }

    @Environment(VigieStore.self) private var store
    let agent: AgentRun
    /// Les étapes du plan de sa conversation : un agent sans nom prend le libellé de l'étape qu'il fait.
    var planSteps: [PlanStep] = []
    var look: Look = .card
    let open: (ConversationPanel) -> Void

    /// Rien écrit depuis 6 min : orange.
    static let quiet: TimeInterval = 6 * 60

    var body: some View {
        Button { open(.agent(agent.id)) } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if failed {
                        Image(systemName: "xmark")
                            .font(.caption.bold())
                            .foregroundStyle(Theme.alert)
                            .accessibilityLabel("En échec")
                    }
                    Text(Fmt.agentTitle(name: agent.name, title: agent.title, id: agent.id, planSteps: planSteps))
                        .textRole(.item, alert: failed)
                        .lineLimit(1)
                }
                if !asked.isEmpty {
                    Text(asked).foregroundStyle(.secondary).lineLimit(1)
                }
                Text(doing).foregroundStyle(.secondary).lineLimit(1)
                Text(timing)
                    .foregroundStyle(silent ? AnyShapeStyle(Theme.warnText) : AnyShapeStyle(.secondary))
                    .monospacedDigit()
                    .lineLimit(1)
            }
            .font(.callout)
            .padding(.leading, look == .card ? 14 : 11)
            .padding(.trailing, look == .card ? 12 : 6)
            .padding(.vertical, look == .card ? 10 : 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(alignment: .leading) {
                if look == .card {
                    ZStack(alignment: .leading) {
                        Rectangle().fill(failed ? AnyShapeStyle(Theme.alert.opacity(0.08)) : AnyShapeStyle(.quinary))
                        Rectangle().fill(barColor).frame(width: 3)
                    }
                    .clipShape(.rect(cornerRadius: Theme.corner))
                } else {
                    Capsule().fill(barColor).frame(width: 3)
                }
            }
        }
        .buttonStyle(TileButtonStyle(cornerRadius: look == .card ? Theme.corner : Theme.cornerInner))
        .help(agent.title ?? agent.id)
    }

    private var running: Bool { agent.status == "running" }
    private var failed: Bool { agent.status == "failed" }
    private var silent: Bool { running && store.now.timeIntervalSince(agent.lastAt ?? store.now) > Self.quiet }

    private var barColor: Color {
        if failed { return Theme.alert }
        if !running { return Color.secondary.opacity(0.4) }
        return silent ? Theme.warn : Theme.live
    }

    /// « Faire · poser les doubles pages » : sa phase, puis ce qu'on lui a demandé (sinon son workflow, lisible).
    private var asked: String {
        let prompt = agent.prompt.map { $0.prefix(1).lowercased() + $0.dropFirst() }
        let parts = [agent.phase, prompt ?? agent.workflow.map(Fmt.workflowTitle)].compactMap { $0?.isEmpty == false ? $0 : nil }
        return ConversationVerdict.sentence(parts.joined(separator: " · "))
    }

    private var doing: String {
        if running { return "▸ \(ConversationVerdict.sentence(agent.lastAction ?? "démarre"))" }
        if failed { return ConversationVerdict.sentence(agent.result ?? "en échec") }
        return ConversationVerdict.sentence(agent.result ?? agent.lastAction ?? "fini")
    }

    private var timing: String {
        if running {
            guard let start = agent.startedAt else { return "En cours" }
            if silent, let last = agent.lastAt { return "Rien écrit depuis \(Fmt.age(since: last, now: store.now))" }
            let text = "Depuis \(Fmt.age(since: start, now: store.now))"
            return WorkflowProgress.remaining(agent, now: store.now).map { "\(text) · \($0)" } ?? text
        }
        if failed { return "En échec\(agent.lastAt.map { " \(ConversationVerdict.at($0, now: store.now))" } ?? "")" }
        let duration = Fmt.duration(ms: agent.durationMs)
        return duration.isEmpty ? "Fini" : "Fini · \(duration)"
    }
}

/// Un workflow : son nom lisible, où il en est (« 3 sur 7 finis · 1 en échec · 2 en cours »), puis la liste de son
/// avancée, une ligne par étape (ou par agent) avec un repère d'état à gauche : fini, en cours (ce qu'il fait, depuis
/// quand, ce qu'il reste), en échec, arrêté, à faire. Longue, la liste garde les derniers finis, ce qui tourne et les
/// prochains à faire, et « Tout afficher » la déplie. Fini, il se replie sur son résultat ; en échec ou arrêté, il
/// garde aussi les lignes qui ont mal fini. La règle : `WorkflowProgress`.
struct WorkflowTile: View {
    @Environment(VigieStore.self) private var store
    let workflow: Workflow
    /// Tous ses agents, en cours et finis (`WorkflowProgress.agents(of:among:in:)`).
    let agents: [AgentRun]
    /// Le plan de la conversation : nomme ses étapes et dit celles qui restent à faire.
    var plan: WorkPlan?
    let open: (ConversationPanel) -> Void

    @State private var showAll = false

    var body: some View {
        let raw = workflow.name ?? workflow.id
        let progress = WorkflowProgress.make(agents: agents, plan: plan, running: running)
        VStack(alignment: .leading, spacing: 6) {
            Button { open(.workflow(workflow.id)) } label: {
                VStack(alignment: .leading, spacing: 6) {
                    CardTitle("Workflow", trailing: trailing, alert: failed)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Fmt.workflowTitle(raw))
                            .textRole(.item)
                            .lineLimit(1)
                            .help(raw)
                        let parts = summary(progress)
                        if !InfoLine.text(parts).isEmpty {
                            InfoLine(parts: parts)
                        }
                    }
                    if running {
                        if progress.items.isEmpty, let log = workflow.lastLog {
                            Text(log).foregroundStyle(.secondary).lineLimit(1)
                        }
                    } else if let result = workflow.result ?? workflow.summary {
                        Text(result).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                // un peu d'air autour du fond de survol, sans décaler le contenu
                .padding(6)
            }
            .buttonStyle(TileButtonStyle())
            .padding(-6)
            if running {
                list(progress)
            } else if failed {
                // en échec ou arrêté : ce qui a mal fini, à ouvrir
                rows(progress.items.filter { $0.state == .failed || $0.state == .stopped }.prefix(3))
            }
        }
        .font(.callout)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quinary, in: .rect(cornerRadius: Theme.corner))
    }

    private var running: Bool { workflow.status == "running" }
    private var failed: Bool { workflow.status == "failed" || workflow.status == "killed" }

    /// À droite du surtitre : depuis quand (en cours), sinon comment il a fini et combien de temps il a pris.
    private var trailing: String {
        if running { return workflow.startedAt.map { "depuis \(Fmt.age(since: $0, now: store.now))" } ?? "en cours" }
        let outcome = workflow.status == "failed" ? "en échec" : workflow.status == "killed" ? "arrêté" : "fini"
        let duration = Fmt.duration(ms: workflow.durationMs)
        return duration.isEmpty ? outcome : "\(outcome) · \(duration)"
    }

    /// Sous le nom : où il en est, d'après sa liste ; sans agent connu (lancé à l'instant, ou ses agents trop anciens
    /// pour le détail), les compteurs du moteur.
    private func summary(_ progress: WorkflowProgress) -> [String?] {
        let parts = progress.summary(running: running)
        if !parts.isEmpty { return parts }
        guard !running else { return [] }
        if let c = workflow.counts, (c.done ?? 0) + (c.failed ?? 0) > 0 {
            return [(c.done ?? 0) > 0 ? Fmt.count(c.done ?? 0, "fini", "finis") : nil,
                    (c.failed ?? 0) > 0 ? "\(Fmt.int(c.failed)) en échec" : nil]
        }
        return [workflow.agents.map { Fmt.count($0, "agent") }]
    }

    /// La liste d'avancée : coupée quand elle est longue, ce qui est caché compté au-dessus et au-dessous.
    @ViewBuilder
    private func list(_ progress: WorkflowProgress) -> some View {
        let shown = progress.shown(all: showAll)
        if !shown.items.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                if shown.earlierFinished > 0 {
                    let more = shown.earlierFailed > 0 ? ", dont \(Fmt.int(shown.earlierFailed)) en échec" : ""
                    countRow("\(Fmt.int(shown.earlierFinished)) \(shown.earlierFinished > 1 ? "autres finis" : "autre fini")\(more)",
                             symbol: "checkmark.circle")
                }
                rows(shown.items)
                if shown.laterTodo > 0 {
                    countRow("\(Fmt.int(shown.laterTodo)) \(shown.laterTodo > 1 ? "autres" : "autre") à venir", symbol: "circle.dotted")
                }
            }
            if shown.hidden > 0 {
                ShowAllButton(count: progress.items.count) {
                    withAnimation(.smooth) { showAll = true }
                }
                .padding(.top, 2)
            }
        }
    }

    private func rows<Items: RandomAccessCollection>(_ items: Items) -> some View where Items.Element == WorkflowProgress.Item {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(items) { item in
                WorkflowProgressRow(item: item, now: store.now, open: open)
            }
        }
        // le repère d'état tombe au bord du texte de la tuile, le fond de survol déborde de 6 pt
        .padding(.horizontal, -6)
    }

    /// Une ligne qui compte ce qui n'est pas montré (« 12 autres finis », « 5 autres à venir »).
    private func countRow(_ text: String, symbol: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: symbol)
                .font(.body)
                .foregroundStyle(.tertiary)
                .frame(width: WorkflowProgressRow.markWidth)
                .accessibilityHidden(true)
            Text(text)
                .foregroundStyle(.secondary)
                .monospacedDigit()
                .lineLimit(1)
        }
        .padding(.vertical, 4)
    }
}

/// Une ligne de l'avancée d'un workflow : son repère d'état à gauche (coche grise, point vert, croix rouge, carré
/// d'arrêt, cercle vide), son nom, « en échec » en puce, et à droite depuis quand elle tourne ; dessous, pour ce qui
/// tourne ou a mal fini, la phase et ce que fait (ou a rendu) son agent. Avec « Différencier sans couleur », le point
/// vert devient un symbole : chaque état a sa forme. Un clic ouvre son agent ; une étape à faire ne s'ouvre pas.
struct WorkflowProgressRow: View {
    let item: WorkflowProgress.Item
    let now: Date
    let open: (ConversationPanel) -> Void

    /// La colonne des repères d'état.
    static let markWidth: CGFloat = 16

    var body: some View {
        if let agent = item.agent {
            Button { open(.agent(agent.id)) } label: { content }
                .buttonStyle(TileButtonStyle())
                .help(agent.title ?? agent.id)
        } else {
            content
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 8) {
                mark
                    .frame(width: Self.markWidth)
                    .accessibilityHidden(true)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    title
                    if item.state == .failed {
                        Chip("en échec", tone: .alert)
                    }
                    Spacer(minLength: 6)
                    if let trailing {
                        Text(trailing)
                            .foregroundStyle(silent ? AnyShapeStyle(Theme.warnText) : AnyShapeStyle(.secondary))
                            .monospacedDigit()
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
            }
            if !InfoLine.text(detail).isEmpty {
                InfoLine(parts: detail)
                    .padding(.leading, Self.markWidth + 8)
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(InfoLine.text([item.title, stateLabel, trailing] + detail))
    }

    private var agent: AgentRun? { item.agent }

    /// Rien écrit depuis 6 min : orange, comme la carte d'un agent.
    private var silent: Bool {
        item.state == .running && now.timeIntervalSince(agent?.lastAt ?? now) > AgentTile.quiet
    }

    @ViewBuilder
    private var mark: some View {
        switch item.state {
        case .done:
            Image(systemName: "checkmark.circle").font(.body).foregroundStyle(.secondary)
        case .failed:
            Image(systemName: "xmark.circle.fill").font(.body).foregroundStyle(Theme.alert)
        case .stopped:
            Image(systemName: "stop.circle").font(.body).foregroundStyle(.secondary)
        case .running:
            // repère fixe, comme `RunningMark` : la durée à droite dit déjà que ça avance
            StateDot(style: AnyShapeStyle(silent ? Theme.warn : Theme.live),
                     symbol: silent ? "hourglass.circle.fill" : Theme.symbol(for: .working), size: 9)
        case .todo:
            Image(systemName: "circle").font(.body).foregroundStyle(.tertiary)
        }
    }

    /// Fini : gris ; en cours ou en échec : un objet qu'on ouvre, en semi-gras ; à faire : texte normal.
    @ViewBuilder
    private var title: some View {
        let text = Text(item.title).lineLimit(1).truncationMode(.tail)
        switch item.state {
        case .running, .failed: text.textRole(.item)
        case .done, .stopped: text.font(.body).foregroundStyle(.secondary)
        case .todo: text.font(.body)
        }
    }

    /// À droite, seulement pour ce qui tourne : « depuis 16 min », ou « rien écrit depuis 8 min ».
    private var trailing: String? {
        guard item.state == .running, let agent else { return nil }
        if silent, let last = agent.lastAt { return "rien écrit depuis \(Fmt.age(since: last, now: now))" }
        return agent.startedAt.map { "depuis \(Fmt.age(since: $0, now: now))" }
    }

    /// Dessous : sa phase et ce que fait son agent (et ce qu'il lui reste), ou ce qu'il a rendu en échec.
    private var detail: [String?] {
        guard let agent else { return [] }
        switch item.state {
        case .running:
            return [agent.phase, ConversationVerdict.sentence(agent.lastAction ?? "démarre"), WorkflowProgress.remaining(agent, now: now)]
        case .failed:
            return [agent.phase, ConversationVerdict.sentence(agent.result ?? agent.lastAction ?? "en échec")]
        case .stopped:
            return [agent.phase, "Arrêté avant la fin"]
        case .done, .todo:
            return []
        }
    }

    private var stateLabel: String {
        switch item.state {
        case .done: "fini"
        case .failed: "en échec"
        case .stopped: "arrêté"
        case .running: "en cours"
        case .todo: "à faire"
        }
    }
}

// MARK: Ligne Journal · Fichiers · Tests…

/// Une ligne de puces, juste sous la tuile d'État : Journal, Fichiers, Tests, MCP, En fond, puis « À regarder » et
/// « À relire » de cette conversation. Une puce vide disparaît ; une puce qui signale un problème prend sa couleur et un
/// symbole (jamais la couleur seule), expliqué au survol et lu par VoiceOver.
struct DetailsBar: View {
    @Environment(VigieStore.self) private var store
    let summary: ConversationSummary
    let model: ConversationDetailModel
    let open: (ConversationPanel) -> Void

    private static let flag = "exclamationmark.circle.fill"

    var body: some View {
        let looks = store.lookItems(for: summary.id).count
        let rereads = store.rereadItems(for: summary.id).count
        WrapLayout(spacing: 6, lineSpacing: 6) {
            if !model.feed.isEmpty {
                journal
            }
            if !model.files.isEmpty || !model.artifacts.isEmpty {
                Chip("Fichiers \(Fmt.int(model.files.count + model.artifacts.count))", size: .regular) { open(.files) }
            }
            if !model.tests.isEmpty {
                let failing = SideTiles.redTest(model, now: store.now) != nil
                let text = "Tests \(Fmt.int(model.tests.count))"
                Chip(text, symbol: failing ? Self.flag : nil, tone: failing ? .alert : .neutral, size: .regular) { open(.tests) }
                    .help(failing ? "Le dernier test est en échec" : "Les tests lancés dans cette conversation")
                    .accessibilityLabel(failing ? "\(text), le dernier en échec" : text)
            }
            if !model.raw.mcp.isEmpty {
                let broken = model.raw.mcp.count { ($0.enabled ?? true) && ($0.mcpStatus == .needsAuth || $0.mcpStatus == .failed) }
                let text = "MCP \(Fmt.int(model.raw.mcp.count))"
                let why = Fmt.count(broken, "à reconnecter ou en échec", "à reconnecter ou en échec")
                Chip(text, symbol: broken > 0 ? Self.flag : nil, tone: broken > 0 ? .warn : .neutral, size: .regular) { open(.mcp) }
                    .help(broken > 0 ? why : "Les MCP utilisés par cette conversation")
                    .accessibilityLabel(broken > 0 ? "\(text), dont \(why)" : text)
            }
            if !model.raw.processes.isEmpty || !model.raw.background.isEmpty {
                Chip("En fond \(Fmt.int(model.raw.processes.count + model.raw.background.count))", size: .regular) { open(.background) }
                    .help(backgroundHelp)
            }
            // la tuile d'État montre déjà les premiers : la puce dit seulement le reste
            if looks > StateTile.shownLooks {
                Chip("\(Fmt.int(looks - StateTile.shownLooks)) de plus à regarder", size: .regular) { open(.answers) }
                    .help("Ce qui a mal tourné ou que tu dois faire toi-même : la liste entière")
            }
            if rereads > 0 {
                Chip("À relire \(Fmt.int(rereads))", size: .regular) { open(.answers) }
                    .help("Ce que Vigie a choisi pour toi")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Le Journal : en rouge, avec un symbole, s'il contient une action refusée d'office ou qui t'attend.
    private var journal: some View {
        let refused = model.feed.count { $0.value.decisionKind == .blocked }
        let waiting = model.feed.count { $0.value.decisionKind == .waiting }
        let flagged = refused + waiting > 0
        let text = "Journal \(Fmt.int(model.feed.count))"
        let why = [refused > 0 ? Fmt.count(refused, "refusée d'office", "refusées d'office") : nil,
                   waiting > 0 ? (waiting > 1 ? "\(waiting) qui t'attendent" : "1 qui t'attend") : nil]
            .compactMap { $0 }.joined(separator: ", ")
        return Chip(text, symbol: flagged ? Self.flag : nil, tone: flagged ? .alert : .neutral, size: .regular) { open(.journal) }
            .help(flagged ? "Dont \(why)" : "Ses actions et leur résultat")
            .accessibilityLabel(flagged ? "\(text), dont \(why)" : text)
    }

    private var backgroundHelp: String {
        guard let background = summary.background, let label = background.label else { return "Ce qu'elle a laissé tourner" }
        let more = (background.count ?? 1) > 1 ? " +\((background.count ?? 1) - 1)" : ""
        return "\(label)\(more) · \(Fmt.memory(mb: background.memoryMb))"
    }
}
