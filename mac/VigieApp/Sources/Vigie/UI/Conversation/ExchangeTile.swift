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

    /// Messages de Claude montrés : les 3 derniers.
    static let shown = 3

    /// Le message d'indice `index` (sur `count`) a sa bulle dans l'Échange : la tuile d'État ne répète pas son « À toi ».
    static func isVisible(_ index: Int, of count: Int) -> Bool {
        index >= count - shown
    }

    var body: some View {
        let detail = model.raw
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                CardTitle("Échange")
                if detail.chapters.count > 1 {
                    // même nom que le panneau qu'il ouvre
                    Button("Tous les échanges (\(Fmt.int(detail.chapters.count)))") { open(.thread) }
                        .buttonStyle(.link)
                        .font(.callout)
                        .fixedSize()
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                if let current = detail.current {
                    youBubble(current)
                    let facts = factsLine(current)
                    if !facts.characters.isEmpty {
                        Text(facts)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
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
                    // en-tête de bulle : le style d'un surtitre compact, dans la couleur de ce que tu écris
                    Text("Toi\(current.start.map { " · \(Fmt.when($0, now: store.now))" } ?? "")")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.youText)
                    // deux lignes entières, même quand la tuile partage la largeur avec la colonne de côté
                    Text(current.brief ?? current.prompt ?? "")
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(Theme.you.opacity(0.12), in: .rect(cornerRadius: Theme.cornerInner))
                .overlay(RoundedRectangle(cornerRadius: Theme.cornerInner).strokeBorder(Theme.you.opacity(0.25)))
            }
            .buttonStyle(TileButtonStyle())
            .help("Ta demande en entier")
            if let relaunch = current.relaunch, let ts = relaunch.ts {
                Text("Relancée par « \(relaunch.prompt ?? "") » · \(Fmt.when(ts, now: store.now))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 60)
    }

    // MARK: Claude

    private func claudeBubble(_ message: ClaudeMessage, index: Int, isLast: Bool) -> some View {
        let live = isLast && !message.isReport && summary.state == .working
        let asks = isLast && message.ask != nil && verdict.tone == .alert
        let headColor: AnyShapeStyle = asks ? AnyShapeStyle(Theme.alertText) : live ? AnyShapeStyle(Theme.liveText) : AnyShapeStyle(.secondary)
        let toYou = message.toYou.flatMap { $0.isEmpty ? nil : $0 }
        return Button { open(.message(index)) } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(label(message, live: live, asks: asks))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(headColor)
                    .monospacedDigit()
                Text(bubbleText(message))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)
                // ce qui te revient, sur sa ligne : il ne se perd pas dans la coupe des deux lignes (la tuile d'État ne
                // le répète pas quand cette bulle est visible)
                if let toYou {
                    Text("À toi : \(toYou)")
                        .fontWeight(.semibold)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.raised, in: .rect(cornerRadius: Theme.cornerInner))
            .overlay(alignment: .leading) {
                if live {
                    UnevenRoundedRectangle(topLeadingRadius: Theme.cornerInner, bottomLeadingRadius: Theme.cornerInner)
                        .fill(Theme.live)
                        .frame(width: 3)
                        .accessibilityHidden(true)
                }
            }
            .overlay(RoundedRectangle(cornerRadius: Theme.cornerInner)
                .strokeBorder(asks ? AnyShapeStyle(Theme.alert) : AnyShapeStyle(.quaternary), lineWidth: asks ? 1.5 : 1))
        }
        .buttonStyle(TileButtonStyle())
        .padding(.trailing, 60)
        .help("Le message en entier")
    }

    private func label(_ message: ClaudeMessage, live: Bool, asks: Bool) -> String {
        let when = message.ts.map { live ? Fmt.ago($0, now: store.now) : Fmt.when($0, now: store.now) } ?? ""
        let parts: [String]
        if asks { parts = ["Claude te demande", when] }
        else if live { parts = ["Claude", "en direct", when] }
        else { parts = message.isReport ? ["Claude", "compte rendu", when] : ["Claude", when] }
        return InfoLine.text(parts)
    }

    /// Sa phrase utile, puis sa question ; sinon le début du texte. « À toi » a sa propre ligne.
    private func bubbleText(_ message: ClaudeMessage) -> String {
        if let brief = message.brief, !brief.isEmpty {
            if let ask = message.ask, ask != brief { return "\(brief) \(ask)" }
            return brief
        }
        return (message.text ?? "").replacingOccurrences(of: "\n", with: " ")
    }

    // MARK: Faits et dernière action

    /// « 4 commits · 38 fichiers · tests réussis à 01:15 · 7 agents finis, 1 en échec » ; un test en échec en rouge.
    private func factsLine(_ c: CurrentRequest) -> AttributedString {
        // (texte, en rouge)
        var parts: [(String, Bool)] = []
        if let v = c.commits, v > 0 { parts.append((Fmt.count(v, "commit"), false)) }
        if let v = c.deploys, v > 0 { parts.append((v > 1 ? "\(v) déploiements" : "déployé", false)) }
        if let v = c.files, v > 0 { parts.append((Fmt.count(v, "fichier"), false)) }
        if let test = lastTest(since: c.start) {
            let when = ConversationVerdict.at(test.ts, now: store.now)
            let failed = test.outcome == .failed
            let text = failed ? "tests en échec" : "tests réussis"
            parts.append((when.isEmpty ? text : "\(text) \(when)", failed))
        }
        let agents = model.doneAgents.filter { ($0.startedAt ?? .distantPast) >= (c.start ?? .distantPast) }
        let failed = agents.count { $0.status == "failed" }
        if !agents.isEmpty {
            parts.append(("\(Fmt.count(agents.count, "agent fini", "agents finis"))\(failed > 0 ? ", \(failed) en échec" : "")", false))
        }
        var line = AttributedString()
        for (offset, part) in parts.prefix(4).enumerated() {
            if offset > 0 { line += AttributedString(" · ") }
            // une ligne seule commence par une majuscule (« Déployé · … »)
            var piece = AttributedString(offset == 0 ? ConversationVerdict.sentence(part.0) : part.0)
            // seul le mot qui signale reste en rouge, le reste de la ligne en gris
            if part.1 { piece.swiftUI.foregroundColor = Theme.alertText }
            line += piece
        }
        return line
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
                    return "Travaille · \(title) · \(Fmt.ago(ts, now: store.now))"
                }
                if agents > 0 { return "Attend \(agents > 1 ? "ses \(agents) agents" : "son agent")" }
                if let last, let title = last.title, let ts = last.ts { return "Travaille · \(title) · \(Fmt.ago(ts, now: store.now))" }
                return "Travaille"
            }()
            HStack(spacing: 6) {
                Circle().fill(Theme.live).frame(width: 6, height: 6).accessibilityHidden(true)
                Text(text).lineLimit(1).monospacedDigit()
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }
}
