import SwiftUI

/// « Maintenant » : ta dernière demande, depuis quand elle travaille, où elle en est (son message en direct,
/// sinon son dernier compte rendu), ce qui en est sorti depuis, et ce qui tourne en ce moment.
struct NowSection: View {
    @Environment(VigieStore.self) private var store
    let summary: ConversationSummary
    let model: ConversationDetailModel?

    @State private var fullReport = false

    var body: some View {
        let now = model?.raw.now
        let current = model?.raw.current
        VStack(alignment: .leading, spacing: 14) {
            if let current, let prompt = current.prompt, !prompt.isEmpty {
                request(prompt: prompt, start: current.start, relaunch: current.relaunch)
            }
            status(now)
            if let current {
                let stats = statsLine(current)
                if !stats.isEmpty {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("Depuis ta demande")
                            .foregroundStyle(.secondary)
                        Text(stats)
                    }
                    .font(.callout)
                }
            }
            runningNow
        }
        .padding(.vertical, 4)
    }

    // MARK: Ta demande

    private func request(prompt: String, start: Date?, relaunch: CurrentRequest.Relaunch?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "text.bubble")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text("« \(prompt) »")
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                Text(requestMeta(start, relaunch: relaunch))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func requestMeta(_ start: Date?, relaunch: CurrentRequest.Relaunch?) -> String {
        guard let start else { return "ta dernière demande" }
        var text = "ta demande · \(Fmt.when(start, now: store.now))"
        if let relaunch, let ts = relaunch.ts { text += " · relancée par « \(relaunch.prompt ?? "") » \(Fmt.when(ts, now: store.now))" }
        let elapsed = store.now.timeIntervalSince(start) * 1000
        if summary.state == .working { text += " · elle y travaille depuis \(Fmt.duration(ms: elapsed))" }
        return text
    }

    // MARK: Où elle en est

    @ViewBuilder
    private func status(_ now: NowState?) -> some View {
        if let live = now?.live, let text = live.text, !text.isEmpty, summary.state == .working {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Circle().fill(Theme.live).frame(width: 7, height: 7)
                VStack(alignment: .leading, spacing: 2) {
                    Text(text)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                    if let ts = live.ts {
                        Text("en direct · \(Fmt.ago(ts, now: store.now))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.live.opacity(0.08), in: .rect(cornerRadius: 9))
        } else if let text = now?.text, !text.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(text)
                    .lineLimit(fullReport ? nil : 3)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                HStack(spacing: 8) {
                    if let ts = now?.ts {
                        Text("son dernier compte rendu · \(Fmt.when(ts, now: store.now))")
                    }
                    if text.count > 220 {
                        Button(fullReport ? "Réduire" : "Tout lire") {
                            withAnimation(.smooth) { fullReport.toggle() }
                        }
                        .buttonStyle(.link)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 9))
        } else if model == nil {
            Text("Lecture…").foregroundStyle(.secondary)
        }
    }

    // MARK: Ce qui en est sorti

    /// « 4 commits · 2 déploiements · 38 fichiers · 412 tests réussis · 1 en échec · 3 agents ».
    private func statsLine(_ c: CurrentRequest) -> String {
        var parts: [String] = []
        if let v = c.commits, v > 0 { parts.append(Fmt.count(v, "commit")) }
        if let v = c.deploys, v > 0 { parts.append(Fmt.count(v, "déploiement")) }
        if let v = c.files, v > 0 { parts.append(Fmt.count(v, "fichier")) }
        if let v = c.testsOk, v > 0 { parts.append(Fmt.count(v, "vérification réussie", "vérifications réussies")) }
        if let v = c.testsFailed, v > 0 { parts.append("\(Fmt.int(v)) en échec") }
        if let v = c.agents, v > 0 { parts.append(Fmt.count(v, "agent")) }
        if let v = c.workflows, v > 0 { parts.append(Fmt.count(v, "workflow")) }
        return parts.joined(separator: " · ")
    }

    // MARK: En ce moment

    @ViewBuilder
    private var runningNow: some View {
        let workflows = model?.raw.workflows.filter { $0.status == "running" } ?? []
        let agents = model?.runningAgents ?? []
        if !workflows.isEmpty || !agents.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("En ce moment")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                ForEach(workflows) { workflow in
                    runningLine(symbol: Icon.workflow, title: workflow.name ?? "Workflow",
                                detail: [workflow.agents.map { Fmt.count($0, "agent") }, workflow.startedAt.map { "depuis \(Fmt.duration(ms: store.now.timeIntervalSince($0) * 1000))" }]
                                    .compactMap { $0 }.joined(separator: " · "))
                }
                ForEach(agents.prefix(6)) { agent in
                    runningLine(symbol: Icon.agent, title: agent.title ?? "Agent",
                                detail: [agent.startedAt.map { "depuis \(Fmt.duration(ms: store.now.timeIntervalSince($0) * 1000))" }, agent.lastAction]
                                    .compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · "))
                }
                if agents.count > 6 {
                    Text("et \(agents.count - 6) autres agents")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func runningLine(symbol: String, title: String, detail: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            ProgressView().controlSize(.mini)
                .frame(width: 14)
            Image(systemName: symbol)
                .foregroundStyle(.secondary)
                .imageScale(.small)
            Text(title)
                .lineLimit(1)
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .font(.callout)
    }
}

/// Feuille de route : le document d'état que la conversation tient à jour, section par section.
/// Ce qui dit où on en est, la suite et ce qui t'attend est déplié ; le reste se déplie au clic.
struct RoadmapView: View {
    @Environment(VigieStore.self) private var store
    let doc: TrackingDoc
    let cwd: String?

    private static let open = /(où on en est|ou on en est|prochaine|suite|attend|ordre|en cours|next|todo|à faire|a faire|status|état)/.ignoresCase()

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let intro = doc.intro, !intro.isEmpty {
                markdown(intro)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(doc.sections.enumerated()), id: \.offset) { _, section in
                RoadmapSection(section: section, expandedAtFirst: section.title.contains(Self.open))
            }
            HStack(spacing: 10) {
                Button("Ouvrir \(relative(doc.path))", systemImage: "doc.text") { SystemActions.openInVSCode(path: doc.path) }
                    .buttonStyle(.link)
                if !doc.others.isEmpty {
                    Text("Aussi : " + doc.others.map { relative($0.path) }.joined(separator: ", "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .font(.callout)
        }
    }

    private func relative(_ path: String) -> String {
        guard let cwd, path.hasPrefix(cwd + "/") else { return (path as NSString).lastPathComponent }
        return String(path.dropFirst(cwd.count + 1))
    }
}

struct RoadmapSection: View {
    let section: TrackingDoc.Section
    let expandedAtFirst: Bool

    @State private var expanded: Bool?

    var body: some View {
        let isOpen = expanded ?? expandedAtFirst
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.smooth) { expanded = !isOpen }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                        .foregroundStyle(.secondary)
                    Text(section.title)
                        .font(.body.weight(.semibold))
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            if isOpen, let text = section.text {
                markdown(text)
                    .font(.callout)
                    .padding(.leading, 18)
            }
        }
    }
}

/// Texte Markdown d'un document (gras, code, liens), retours à la ligne gardés. Ce texte vient d'un agent : seuls
/// les liens web (http, https) s'ouvrent ; un lien vers un fichier ou un partage du Mac (file:, smb:…) reste inerte.
@MainActor
func markdown(_ text: String) -> some View {
    var attributed = (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
        ?? AttributedString(text)
    for run in attributed.runs {
        if let link = run.link, !["http", "https"].contains(link.scheme?.lowercased() ?? "") {
            attributed[run.range].link = nil
        }
    }
    return Text(attributed)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
}
