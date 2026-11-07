import SwiftUI

/// La tuile d'État, toujours en haut : le verdict en un mot et une couleur, ce qu'elle fait ou attend en une ligne, ce
/// qui t'attend (décisions) et ce qui a mal tourné ou que tu dois faire toi-même (« À regarder » : refus d'office, sudo
/// à lancer toi-même, limite), depuis quand, deux ou trois puces quand il y a lieu, et les boutons quand c'est à toi
/// d'agir. Les réglages de la conversation (compte, auto-accept, MCP du compte) sont dans la barre juste au-dessus :
/// la tuile ne les répète pas.
struct StateTile: View {
    @Environment(VigieStore.self) private var store
    let summary: ConversationSummary
    let model: ConversationDetailModel?
    let verdict: ConversationVerdict
    let open: (ConversationPanel) -> Void

    /// « À regarder » montré dans la tuile ; au-delà, la puce « À regarder » de la ligne du dessous ouvre la liste.
    private static let shownLooks = 3

    var body: some View {
        let looks = store.lookItems(for: summary.id)
        VStack(alignment: .leading, spacing: 6) {
            // le verdict et, à droite, ce qu'elle consomme ; dessous quand la place manque
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    title
                    Spacer(minLength: 8)
                    meta
                }
                VStack(alignment: .leading, spacing: 4) {
                    title
                    meta
                }
            }
            if let line = verdict.line, !line.isEmpty {
                Text(line)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            if !verdict.items.isEmpty || !looks.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(verdict.items) { item in
                        ReviewRow(item: item, inConversation: true)
                    }
                    ForEach(looks.prefix(Self.shownLooks)) { item in
                        ReviewRow(item: item, inConversation: true)
                    }
                }
            }
            WrapLayout(spacing: 8, lineSpacing: 6) {
                if !timeLine.isEmpty {
                    Text(timeLine)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .help(placeHelp)
                        .padding(.vertical, 3)
                }
                ForEach(notes) { note in
                    noteView(note)
                }
                if verdict.showCause, let model {
                    if SideTiles.redTest(model, now: store.now) != nil {
                        Chip("Voir les tests", symbol: Icon.test, size: .regular, raised: true) { open(.tests) }
                    } else if !model.feed.isEmpty {
                        Chip("Journal", size: .regular, raised: true) { open(.journal) }
                    }
                }
                if verdict.openButton {
                    AsyncButton(verdict.reply ? summary.replyLabel : summary.openLabel) {
                        await store.openConversationInVSCode(summary.id, cwd: summary.cwd)
                    }
                    .glassButton(.primary)
                }
            }
            .font(.callout)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .controlSize(.small)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background, in: .rect(cornerRadius: Theme.corner))
        .accessibilityElement(children: .contain)
    }

    /// Le verdict, écrit une fois dans sa couleur de texte (pas de rond en plus : le mot suffit, même sans couleur).
    private var title: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(verdict.title)
                .font(.title3.bold())
                .foregroundStyle(titleColor)
                .accessibilityAddTraits(.isHeader)
            if let since = verdict.since {
                Text("· \(since)")
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        }
    }

    private var titleColor: AnyShapeStyle {
        switch verdict.tone {
        case .live: AnyShapeStyle(Theme.liveText)
        case .warn: AnyShapeStyle(Theme.warnText)
        case .alert: AnyShapeStyle(Theme.alertText)
        case .calm: AnyShapeStyle(.primary)
        }
    }

    private var background: AnyShapeStyle {
        switch verdict.tone {
        case .alert: AnyShapeStyle(Theme.alert.opacity(0.08))
        case .warn: AnyShapeStyle(Theme.warn.opacity(0.08))
        case .live, .calm: AnyShapeStyle(.quinary)
        }
    }

    // MARK: À droite : compte (s'il tourne ailleurs), débit, part de la semaine

    /// Le compte n'est dit ici que s'il n'est pas celui de la barre : pendant une bascule, la tuile dit où elle tourne
    /// encore (la barre montre le compte choisi).
    private var otherAccount: String? {
        guard let running = summary.account?.running, let chosen = summary.accountId, running != chosen else { return nil }
        return store.account(running)?.displayName ?? running
    }

    private var rate: ConversationRate? {
        guard let rate = summary.rate, (rate.tokensPerMin ?? 0) > 0 else { return nil }
        return rate
    }

    @ViewBuilder
    private var meta: some View {
        let other = otherAccount
        let week = summary.weekPct
        if other != nil || rate != nil || week != nil {
            HStack(spacing: 6) {
                if let other {
                    Text("Tourne encore sur \(other)")
                        .foregroundStyle(.secondary)
                }
                if let rate {
                    if other != nil { separator }
                    RateBadge(rate: rate, alert: summary.alert?.isRunaway == true, compact: true, live: summary.state == .working)
                }
                if let week {
                    if other != nil || rate != nil { separator }
                    Text("\(Fmt.pct(week)) de la semaine")
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .help(weekHelp)
                }
            }
            .font(.callout)
            .lineLimit(1)
        }
    }

    private var separator: some View {
        Text("·").foregroundStyle(.tertiary).accessibilityHidden(true)
    }

    private var weekHelp: String {
        let name = store.account(store.runningAccountId(of: summary))?.displayName ?? "son compte"
        return "Ce que cette conversation a pris de la semaine de \(name), depuis sa dernière remise à zéro (estimation)"
    }

    // MARK: Ligne du bas : depuis quand, et les puces

    /// « Travaille sur ta demande depuis 8 h · dernière action il y a 12 s ».
    private var timeLine: String {
        var parts: [String] = []
        if let start = model?.raw.current?.start {
            if verdict.title == "Finie", let end = model?.raw.messages.last(where: \.isReport)?.ts {
                parts.append("ta demande a pris \(Fmt.duration(ms: end.timeIntervalSince(start) * 1000))")
            } else if summary.state == .working {
                parts.append("travaille sur ta demande depuis \(Fmt.age(since: start, now: store.now))")
            } else if summary.state != .closed {
                parts.append("demande faite \(Fmt.ago(start, now: store.now))")
            }
        }
        if let last = summary.lastActivity { parts.append("dernière action \(Fmt.ago(last, now: store.now))") }
        return ConversationVerdict.sentence(parts.joined(separator: " · "))
    }

    /// Dossier, branche, début : au survol.
    private var placeHelp: String {
        var parts: [String] = []
        if let cwd = summary.cwd { parts.append(Fmt.shortPath(cwd)) }
        if let branch = summary.branch { parts.append("branche \(branch)") }
        if let started = summary.startedAt { parts.append("ouverte \(Fmt.when(started, now: store.now))") }
        return parts.joined(separator: " · ")
    }

    struct Note: Identifiable {
        enum Style { case plain, warn }
        let id: String
        let text: String
        var style: Style = .plain
        var panel: ConversationPanel?
        var switchTo: String?
        /// Texte venu de Claude, de longueur libre : il se coupe (les autres puces ne se coupent jamais).
        var free = false
    }

    /// Trois puces au plus, dans cet ordre : ce qui te revient (si sa bulle n'est pas déjà dans l'Échange), une
    /// bascule de compte, un MCP en panne utilisé ici, ce qui tourne en fond (si la ligne Journal · Fichiers… ne le dit
    /// pas déjà). L'auto-accept forcé n'y est plus : la barre de réglages le dit.
    private var notes: [Note] {
        var list: [Note] = []
        let messages = model?.raw.messages ?? []
        if let index = messages.lastIndex(where: { $0.toYou != nil }), let toYou = messages[index].toYou,
           !ExchangeTile.isVisible(index, of: messages.count) {
            list.append(Note(id: "you", text: "À toi : \(toYou)", panel: .message(index), free: true))
        }
        if let info = summary.account, let running = info.running {
            let to = info.pending?.to ?? summary.pendingAccountId.flatMap { $0 != running ? $0 : nil }
            if let to {
                list.append(Note(id: "switch", text: "→ \(store.account(to)?.displayName ?? to) à la fin du tour", style: .warn, switchTo: to))
            }
        }
        if let broken = model?.raw.mcp.first(where: { ($0.enabled ?? true) && ($0.uses ?? 0) > 0 && ($0.mcpStatus == .needsAuth || $0.mcpStatus == .failed) }) {
            let what = broken.mcpStatus == .failed ? "en échec" : "à reconnecter"
            list.append(Note(id: "mcp", text: "\(broken.name) \(what)", style: .warn, panel: .mcp))
        }
        let detailsShowBackground = !(model?.raw.processes.isEmpty ?? true) || !(model?.raw.background.isEmpty ?? true)
        if !detailsShowBackground, let background = summary.background, let label = background.label {
            let more = (background.count ?? 1) > 1 ? " +\((background.count ?? 1) - 1)" : ""
            list.append(Note(id: "bg", text: "En fond : \(label)\(more) · \(Fmt.memory(mb: background.memoryMb))", panel: .background))
        }
        return Array(list.prefix(3))
    }

    @ViewBuilder
    private func noteView(_ note: Note) -> some View {
        if note.free, let panel = note.panel {
            // même aspect qu'une puce posée, mais le texte se coupe en fin, entier au survol
            Button { open(panel) } label: {
                HStack(spacing: 4) {
                    Text(note.text)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
                .foregroundStyle(.primary)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Theme.raised, in: .capsule)
            }
            .buttonStyle(ChipButtonStyle())
            .help(note.text)
        } else if let to = note.switchTo {
            HStack(spacing: 4) {
                Chip(note.text, tone: .warn, size: .regular)
                AsyncButton("Tout de suite") { await store.switchAccount(of: summary.id, to: to, now: true) }
                    .buttonStyle(.borderless)
                    .help("Interrompt son travail et la relance sur l'autre compte. Tu écris « continue » pour la reprendre.")
            }
        } else if let panel = note.panel {
            Chip(note.text, symbol: note.id == "mcp" ? Icon.mcp : nil, tone: note.style == .warn ? .warn : .neutral,
                 size: .regular, raised: true) { open(panel) }
        } else {
            Chip(note.text, tone: note.style == .warn ? .warn : .neutral, size: .regular, raised: true)
        }
    }
}
