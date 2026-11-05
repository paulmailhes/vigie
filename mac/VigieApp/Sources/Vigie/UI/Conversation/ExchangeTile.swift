import SwiftUI

/// L'Échange : ta vraie demande (violet, à droite), ce qu'elle a donné (une ligne de faits), jusqu'à 3 messages de
/// Claude écrits depuis (neutres, à gauche ; barre verte en direct ; contour rouge quand il te demande quelque chose),
/// puis sa dernière action. Deux lignes par bulle au plus : un clic ouvre le texte entier à droite.
struct ExchangeTile: View {
    @Environment(VigieStore.self) private var store
    let summary: ConversationSummary
    let model: ConversationDetailModel
    let verdict: ConversationVerdict
    let open: (ConversationPanel) -> Void

    private static let shown = 3

    var body: some View {
        let detail = model.raw
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Échange")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if detail.chapters.count > 1 {
                    Button("Échanges précédents (\(detail.chapters.count - 1))") { open(.thread) }
                        .buttonStyle(.link)
                        .font(.callout)
                }
            }
            if let current = detail.current {
                youBubble(current)
                let facts = factsLine(current)
                if !facts.isEmpty {
                    Text(facts)
                        .font(.caption)
                        .foregroundStyle(redFacts ? AnyShapeStyle(Theme.alert) : AnyShapeStyle(.secondary))
                        .frame(maxWidth: .infinity)
                        .multilineTextAlignment(.center)
                }
            }
            let messages = Array(detail.messages.enumerated()).suffix(Self.shown)
            if messages.isEmpty, detail.current != nil, summary.state == .working {
                Text("Claude n'a encore rien écrit sur cette demande\(workingSince)")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(messages), id: \.offset) { index, message in
                claudeBubble(message, index: index, isLast: index == detail.messages.count - 1)
            }
            nowLine
            if verdict.tone == .alert, verdict.title == "T'attend" {
                HStack {
                    Spacer()
                    AsyncButton("\(summary.replyLabel) ↗") { await store.openConversationInVSCode(summary.id, cwd: summary.cwd) }
                        .buttonStyle(.link)
                }
                .font(.callout)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quinary, in: .rect(cornerRadius: Theme.corner))
    }

    // MARK: Toi

    private func youBubble(_ current: CurrentRequest) -> some View {
        VStack(alignment: .trailing, spacing: 3) {
            Button { open(.request) } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Toi\(current.start.map { " · \(Fmt.when($0, now: store.now))" } ?? "")")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.you)
                    Text(current.brief ?? current.prompt ?? "")
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(Theme.you.opacity(0.12), in: .rect(cornerRadius: 11))
                .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(Theme.you.opacity(0.25)))
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .help("Ta demande en entier")
            if let relaunch = current.relaunch, let ts = relaunch.ts {
                Text("relancée par « \(relaunch.prompt ?? "") » · \(Fmt.time(ts))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 60)
    }

    // MARK: Claude

    private func claudeBubble(_ message: ClaudeMessage, index: Int, isLast: Bool) -> some View {
        let live = isLast && !message.isReport && summary.state == .working
        let asks = isLast && message.ask != nil && verdict.tone == .alert
        let tint: Color = asks ? Theme.alert : live ? Theme.live : .secondary
        return Button { open(.message(index)) } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(label(message, live: live, asks: asks))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(asks || live ? AnyShapeStyle(tint) : AnyShapeStyle(.secondary))
                Text(bubbleText(message))
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.background.opacity(0.7), in: .rect(cornerRadius: 11))
            .overlay(alignment: .leading) {
                if live {
                    UnevenRoundedRectangle(topLeadingRadius: 11, bottomLeadingRadius: 11)
                        .fill(Theme.live)
                        .frame(width: 3)
                }
            }
            .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(asks ? AnyShapeStyle(Theme.alert) : AnyShapeStyle(.quaternary),
                                                                     lineWidth: asks ? 1.5 : 1))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .padding(.trailing, 60)
        .help("Le message en entier")
    }

    private func label(_ message: ClaudeMessage, live: Bool, asks: Bool) -> String {
        let when = message.ts.map { live ? Fmt.ago($0, now: store.now) : Fmt.time($0) } ?? ""
        if asks { return "Claude te demande · \(when)" }
        if live { return "Claude · en direct · \(when)" }
        return message.isReport ? "Claude · compte rendu · \(when)" : "Claude · \(when)"
    }

    /// Sa phrase utile, puis ce qui te revient ; sinon le début du texte.
    private func bubbleText(_ message: ClaudeMessage) -> String {
        if let brief = message.brief, !brief.isEmpty {
            if let ask = message.ask, ask != brief { return "\(brief) \(ask)" }
            if let toYou = message.toYou { return "\(brief) À toi : \(toYou)" }
            return brief
        }
        return (message.text ?? "").replacingOccurrences(of: "\n", with: " ")
    }

    // MARK: Faits et dernière action

    /// « 4 commits · 38 fichiers · tests ✓ 01:15 · 7 agents finis, 1 échec ».
    private func factsLine(_ c: CurrentRequest) -> String {
        var parts: [String] = []
        if let v = c.commits, v > 0 { parts.append(Fmt.count(v, "commit")) }
        if let v = c.deploys, v > 0 { parts.append(v > 1 ? "\(v) déploiements" : "déployé") }
        if let v = c.files, v > 0 { parts.append(Fmt.count(v, "fichier")) }
        if let test = lastTest(since: c.start) {
            parts.append(test.outcome == .failed ? "tests rouges \(test.ts.map(Fmt.time) ?? "")" : "tests ✓ \(test.ts.map(Fmt.time) ?? "")")
        }
        let agents = model.doneAgents.filter { ($0.startedAt ?? .distantPast) >= (c.start ?? .distantPast) }
        let failed = agents.count { $0.status == "failed" }
        if !agents.isEmpty {
            parts.append("\(Fmt.count(agents.count, "agent fini", "agents finis"))\(failed > 0 ? ", \(failed) en échec" : "")")
        }
        return parts.prefix(4).joined(separator: " · ")
    }

    private var redFacts: Bool {
        guard let start = model.raw.current?.start else { return false }
        return lastTest(since: start)?.outcome == .failed
    }

    private func lastTest(since start: Date?) -> TestRun? {
        model.tests.map(\.value).first { test in
            test.outcome != .pending && test.outcome != .unknown && (test.ts ?? .distantPast) >= (start ?? .distantPast)
        }
    }

    private var workingSince: String {
        guard let start = model.raw.current?.start else { return "" }
        return " · travaille depuis \(Fmt.age(since: start, now: store.now))"
    }

    /// Quand elle travaille : sa dernière action, ou qu'elle attend ses agents.
    @ViewBuilder
    private var nowLine: some View {
        if summary.state == .working {
            let last = model.raw.activity.first
            let agents = summary.agentsRunning ?? 0
            let text: String = {
                if let last, last.agent == nil, let title = last.title, let ts = last.ts, store.now.timeIntervalSince(ts) < 120 {
                    return "travaille · \(title) · \(Fmt.ago(ts, now: store.now))"
                }
                if agents > 0 { return "attend \(agents > 1 ? "ses \(agents) agents" : "son agent")" }
                if let last, let title = last.title, let ts = last.ts { return "travaille · \(title) · \(Fmt.ago(ts, now: store.now))" }
                return "travaille"
            }()
            HStack(spacing: 6) {
                Circle().fill(Theme.live).frame(width: 6, height: 6)
                Text(text).lineLimit(1)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }
}
