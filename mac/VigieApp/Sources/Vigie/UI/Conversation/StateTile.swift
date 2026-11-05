import SwiftUI

/// La tuile d'État, toujours en haut : le verdict en un mot et une couleur, ce qu'elle fait ou attend en une ligne,
/// depuis quand, deux ou trois puces quand il y a lieu, et les boutons seulement quand c'est à toi d'agir.
/// Les réglages de la conversation (compte, auto-accept, MCP du compte) sont dans la barre d'outils.
struct StateTile: View {
    @Environment(VigieStore.self) private var store
    let summary: ConversationSummary
    let model: ConversationDetailModel?
    let verdict: ConversationVerdict
    let open: (ConversationPanel) -> Void


    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .center, spacing: 8) {
                Circle()
                    .fill(color)
                    .frame(width: 9, height: 9)
                    .accessibilityHidden(true)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(verdict.title)
                        .font(.title3.bold())
                        .foregroundStyle(verdict.tone == .calm ? AnyShapeStyle(.primary) : AnyShapeStyle(color))
                    if let since = verdict.since {
                        Text("· \(since)")
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                meta
            }
            if let line = verdict.line, !line.isEmpty {
                Text(line)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 17)
                    .textSelection(.enabled)
            }
            if !verdict.items.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(verdict.items) { item in
                        ReviewRow(item: item, inConversation: true)
                    }
                }
                .padding(.leading, 17)
            }
            WrapLayout(spacing: 8, lineSpacing: 6) {
                Text(timeLine)
                    .foregroundStyle(.secondary)
                    .help(placeHelp)
                    .padding(.vertical, 2)
                ForEach(chips) { chip in
                    chipView(chip)
                }
                if verdict.openButton {
                    AsyncButton(summary.replyLabel) { await store.openConversationInVSCode(summary.id, cwd: summary.cwd) }
                        .glassButton(.primary)
                }
            }
            .font(.callout)
            .padding(.leading, 17)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background, in: .rect(cornerRadius: Theme.corner))
        .accessibilityElement(children: .contain)
    }

    private var color: Color {
        switch verdict.tone {
        case .live: Theme.live
        case .warn: Theme.warn
        case .alert: Theme.alert
        case .calm: Color.secondary.opacity(0.7)
        }
    }

    private var background: AnyShapeStyle {
        switch verdict.tone {
        case .alert: AnyShapeStyle(Theme.alert.opacity(0.08))
        case .warn: AnyShapeStyle(Theme.warn.opacity(0.08))
        case .live, .calm: AnyShapeStyle(.quinary)
        }
    }

    // MARK: À droite : compte, débit

    private var meta: some View {
        HStack(spacing: 8) {
            Text(store.account(store.runningAccountId(of: summary))?.displayName ?? "")
                .foregroundStyle(.secondary)
            if let rate = summary.rate, (rate.tokensPerMin ?? 0) > 0 {
                RateBadge(rate: rate, alert: summary.alert?.isRunaway == true, compact: true, live: summary.state == .working)
            }
        }
        .font(.callout)
        .lineLimit(1)
    }

    // MARK: Ligne 3 : depuis quand, et les puces

    /// « sur ta demande depuis 8 h · dernière activité il y a 12 s ».
    private var timeLine: String {
        var parts: [String] = []
        if let start = model?.raw.current?.start {
            if verdict.title == "Finie", let end = model?.raw.messages.last(where: \.isReport)?.ts {
                parts.append("ta demande a pris \(Fmt.duration(ms: end.timeIntervalSince(start) * 1000))")
            } else if summary.state != .closed {
                parts.append("sur ta demande depuis \(Fmt.age(since: start, now: store.now))")
            }
        }
        if let last = summary.lastActivity { parts.append("dernière activité \(Fmt.ago(last, now: store.now))") }
        return parts.joined(separator: " · ")
    }

    /// Dossier, branche, début : au survol.
    private var placeHelp: String {
        var parts: [String] = []
        if let cwd = summary.cwd { parts.append(Fmt.shortPath(cwd)) }
        if let branch = summary.branch { parts.append("branche \(branch)") }
        if let started = summary.startedAt { parts.append("ouverte \(Fmt.when(started, now: store.now))") }
        return parts.joined(separator: " · ")
    }

    struct Chip: Identifiable {
        enum Style { case plain, warn }
        let id: String
        let text: String
        var style: Style = .plain
        var panel: ConversationPanel?
        var switchTo: String?
    }

    /// Trois puces au plus, dans cet ordre : ce qui te revient, une bascule de compte, un MCP en panne utilisé ici,
    /// ce qui tourne en fond, un réglage qui s'écarte du général.
    private var chips: [Chip] {
        var list: [Chip] = []
        let messages = model?.raw.messages ?? []
        if let toYou = messages.last(where: { $0.toYou != nil })?.toYou {
            list.append(Chip(id: "you", text: "À toi : \(toYou)", panel: messages.lastIndex(where: { $0.toYou != nil }).map { .message($0) }))
        }
        if let info = summary.account, let running = info.running {
            let to = info.pending?.to ?? summary.pendingAccountId.flatMap { $0 != running ? $0 : nil }
            if let to {
                list.append(Chip(id: "switch", text: "→ \(store.account(to)?.displayName ?? to) à la fin du tour", style: .warn, switchTo: to))
            }
        }
        if let broken = model?.raw.mcp.first(where: { ($0.enabled ?? true) && ($0.uses ?? 0) > 0 && ($0.mcpStatus == .needsAuth || $0.mcpStatus == .failed) }) {
            let what = broken.mcpStatus == .failed ? "en échec" : "à reconnecter"
            list.append(Chip(id: "mcp", text: "\(broken.name) \(what)", style: .warn, panel: .mcp))
        }
        if let background = summary.background, let label = background.label {
            let more = (background.count ?? 1) > 1 ? " +\((background.count ?? 1) - 1)" : ""
            list.append(Chip(id: "bg", text: "En fond : \(label)\(more) · \(Fmt.memory(mb: background.memoryMb))", panel: .background))
        }
        if let override = summary.autoAcceptOverride {
            list.append(Chip(id: "auto", text: override ? "Auto-accept : toujours ici" : "Auto-accept : jamais ici"))
        }
        return Array(list.prefix(3))
    }

    @ViewBuilder
    private func chipView(_ chip: Chip) -> some View {
        let label = HStack(spacing: 4) {
            Text(chip.text).lineLimit(1)
            if chip.panel != nil { Image(systemName: "chevron.right").font(.caption2) }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
        .foregroundStyle(chip.style == .warn ? AnyShapeStyle(Theme.warn) : AnyShapeStyle(.primary))
        .background(.background.opacity(0.6), in: .capsule)
        .overlay(Capsule().strokeBorder(chip.style == .warn ? AnyShapeStyle(Theme.warn.opacity(0.5)) : AnyShapeStyle(.quaternary)))
        if let panel = chip.panel {
            Button { open(panel) } label: { label }
                .buttonStyle(.plain)
        } else if let to = chip.switchTo {
            HStack(spacing: 4) {
                label
                AsyncButton("Tout de suite") { await store.switchAccount(of: summary.id, to: to, now: true) }
                    .buttonStyle(.borderless)
                    .help("Interrompt son travail et la relance sur l'autre compte. Tu écris « continue » pour la reprendre.")
            }
        } else {
            label
        }
    }
}
