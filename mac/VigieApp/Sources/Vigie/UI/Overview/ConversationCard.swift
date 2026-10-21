import SwiftUI

/// Grille des conversations ouvertes : une carte chacune, ce qui t'attend d'abord.
struct ConversationGrid: View {
    @Environment(VigieStore.self) private var store

    var body: some View {
        let open = sorted(store.conversations.filter(\.isOpen))
        if open.isEmpty {
            Label("Aucune conversation ouverte", systemImage: "moon.zzz")
                .foregroundStyle(.secondary)
                .padding(.horizontal, 6)
        } else {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 300, maximum: 560), spacing: 14, alignment: .top)],
                      alignment: .leading, spacing: 14) {
                ForEach(open) { conversation in
                    ConversationCard(conversation: conversation,
                                     data: CardData(summary: conversation, detail: store.details[conversation.id]?.raw,
                                                    since: store.since, now: store.now),
                                     sensitive: sensitiveItem(for: conversation.id))
                }
            }
        }
    }

    /// Ce qui t'attend d'abord, puis ce qui travaille, puis le reste (ordre du moteur conservé).
    private func sorted(_ list: [ConversationSummary]) -> [ConversationSummary] {
        func rank(_ conversation: ConversationSummary) -> Int {
            switch conversation.state {
            case .waiting, .blocked: 0
            // travaille / au repos alternent à chaque tour : ça ne doit pas faire bouger les cartes
            case .working, .idle, .unknown, .closed: 1
            }
        }
        return list.enumerated()
            .sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }
            .map(\.element)
    }

    /// L'action sensible de la conversation : celle qui attend ta décision d'abord.
    private func sensitiveItem(for id: String) -> ReviewItem? {
        let items = store.toReview.filter { $0.conversationId == id && $0.reviewKind == .blocked }
        return items.first(where: \.needsDecision) ?? items.first
    }
}

/// La carte d'une conversation : chiffres et icônes, peu de mots. Clic = ouvre la conversation.
struct ConversationCard: View {
    @Environment(VigieStore.self) private var store
    let conversation: ConversationSummary
    let data: CardData
    let sensitive: ReviewItem?

    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if let alert = runaway {
                Label(alert.reason ?? "Consommation anormale", systemImage: Icon.runaway)
                    .labelStyle(CompactLabelStyle())
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .lineLimit(1)
                    .help(runawayHelp(alert))
            }
            if Theme.needsYou(conversation.state) || sensitive != nil {
                attention
            }
            progress
            testsLine
            Spacer(minLength: 0)
            footer
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 168, alignment: .topLeading)
        .background(hovering ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.quinary), in: .rect(cornerRadius: Theme.corner))
        .overlay {
            if runaway != nil {
                RoundedRectangle(cornerRadius: Theme.corner)
                    .strokeBorder(Color.orange.opacity(0.55), lineWidth: 1.5)
            }
        }
        .contentShape(.rect(cornerRadius: Theme.corner))
        .onHover { hovering = $0 }
        .onTapGesture { open() }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("\(conversation.shortTitle), \(Theme.label(for: conversation.state))")
        .accessibilityAction { open() }
        .help("Ouvrir la conversation")
    }

    private func open() {
        store.route = .conversation(conversation.id)
    }

    /// « S'emballe » : consommation anormale, tests qui échouent en boucle, agent qui se répète.
    private var runaway: ConversationAlert? {
        guard let alert = conversation.alert, alert.isRunaway else { return nil }
        return alert
    }

    private func runawayHelp(_ alert: ConversationAlert) -> String {
        var text = "S'emballe"
        if let since = alert.since { text += " depuis \(Fmt.time(since))" }
        if let reason = alert.reason { text += " : \(reason)" }
        return text
    }

    // MARK: En-tête

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            StatusDot(status: conversation.state)
            VStack(alignment: .leading, spacing: 1) {
                Text(conversation.shortTitle)
                    .font(.headline)
                    .lineLimit(1)
                if let title = conversation.title, !title.isEmpty, title != conversation.shortTitle {
                    Text(title)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            accountChip
        }
    }

    private var accountChip: some View {
        let account = store.account(conversation.accountId)
        let week = account?.usage?.week?.pct
        return HStack(spacing: 4) {
            Text(account?.displayName ?? conversation.accountId ?? "Compte")
            if let pct = conversation.weekPct {
                Text("≈ \(Fmt.pct(pct))")
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize()
        .help(accountHelp(account: account, week: week))
    }

    private func accountHelp(account: Account?, week: Double?) -> String {
        let name = account?.displayName ?? "ce compte"
        var parts: [String] = []
        if let pct = conversation.weekPct { parts.append("≈ \(Fmt.pct(pct)) de la semaine de \(name)") }
        if let week { parts.append("compte à \(Fmt.pct(week))") }
        return parts.isEmpty ? "Compte \(name)" : parts.joined(separator: " · ")
    }

    // MARK: Ce qui t'attend

    @ViewBuilder
    private var attention: some View {
        if let sensitive {
            Button {
                store.blockedRequest = sensitive
            } label: {
                Label(sensitiveText(sensitive), systemImage: Icon.guardRule)
                    .lineLimit(1)
            }
            .buttonStyle(.link)
            .foregroundStyle(sensitive.needsDecision ? AnyShapeStyle(Color.red) : AnyShapeStyle(.secondary))
            .font(.callout)
            .help("Voir l'action")
        } else {
            Label(conversation.waitingFor ?? Theme.label(for: conversation.state), systemImage: Icon.waiting)
                .font(.callout)
                .foregroundStyle(.red)
                .lineLimit(1)
        }
    }

    private func sensitiveText(_ item: ReviewItem) -> String {
        let what = item.rule ?? item.title ?? "Action sensible"
        if item.isAwaitingApproval { return "À autoriser dans Vigie · \(what)" }
        guard item.isPendingDecision else { return "Bloquée · \(what)" }
        if let expires = item.expiresAt {
            let minutes = max(0, Int(expires.timeIntervalSince(store.now) / 60))
            return "À autoriser · \(what) · \(minutes) min"
        }
        return "À autoriser · \(what)"
    }

    // MARK: Avancement

    @ViewBuilder
    private var progress: some View {
        if data.hasProgress {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    ProgressView(value: Double(data.progressDone), total: Double(data.progressTotal))
                        .progressViewStyle(.linear)
                        .tint(conversation.state == .working ? Theme.live : Color.secondary)
                    Text("\(data.progressDone) sur \(data.progressTotal)")
                        .font(.callout.weight(.medium))
                        .monospacedDigit()
                        .fixedSize()
                }
                if let current = data.current, !current.isEmpty {
                    Label(current, systemImage: "arrowtriangle.right.fill")
                        .labelStyle(CompactLabelStyle())
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .help(data.progressLabel ?? "Avancement")
        } else if let headline = conversation.headline, !headline.isEmpty {
            Text(headline)
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
    }

    // MARK: Tests

    @ViewBuilder
    private var testsLine: some View {
        if data.testsFailed > 0 {
            VStack(alignment: .leading, spacing: 2) {
                Label(failureHeadline, systemImage: Icon.testFailed)
                    .labelStyle(CompactLabelStyle())
                    .font(.callout.weight(.medium))
                    .lineLimit(1)
                ForEach(Array(data.failures.prefix(2).enumerated()), id: \.offset) { _, failure in
                    if let line = failure.line, !line.isEmpty {
                        Text(line)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .padding(.leading, 20)
                    }
                }
            }
            .help(data.failures.map { [$0.title, $0.line].compactMap { $0 }.joined(separator: " : ") }.joined(separator: "\n"))
        } else if data.testsRunning > 0 {
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text(Fmt.count(data.testsRunning, "test en cours", "tests en cours"))
            }
            .font(.callout)
            .foregroundStyle(.secondary)
        } else if data.testsLastOk == true {
            Label(okText, systemImage: Icon.test)
                .labelStyle(CompactLabelStyle())
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    /// « 2 échecs · vitest + tsc » : où sont les échecs.
    private var failureHeadline: String {
        let count = Fmt.count(data.testsFailed, "échec")
        let place = data.failures.first?.title ?? data.testsLastTitle
        var parts = [count]
        if let place, !place.isEmpty { parts.append(place) }
        if data.testsRunning > 0 { parts.append("\(data.testsRunning) en cours") }
        return parts.joined(separator: " · ")
    }

    private var okText: String {
        var parts = ["OK"]
        if let title = data.testsLastTitle, !title.isEmpty { parts.append(title) }
        if let ts = data.testsLastTs { parts.append(Fmt.when(ts, now: store.now)) }
        return parts.joined(separator: " · ")
    }

    // MARK: Pied : acceptations, artefacts, agents, workflows

    private var footer: some View {
        HStack(spacing: 14) {
            if let today = data.acceptedToday {
                Metric(symbol: Icon.accepted, text: acceptedText(today))
                    .help(acceptedHelp(today))
            }
            if let count = data.artifactsCount, count > 0 {
                Metric(symbol: Icon.artifact, text: [Fmt.int(count), data.lastArtifact].compactMap { $0 }.joined(separator: " · "))
                    .help(data.lastArtifact.map { "\(Fmt.count(count, "artefact")) · dernier : \($0)" } ?? Fmt.count(count, "artefact"))
                    .layoutPriority(-1)
            }
            Spacer(minLength: 0)
            if let rate = conversation.rate {
                RateBadge(rate: rate, alert: runaway != nil)
            }
            if let agents = conversation.agentsRunning, agents > 0 {
                Metric(symbol: Icon.agent, text: Fmt.int(agents))
                    .help(Fmt.count(agents, "agent en cours", "agents en cours"))
            }
            if let workflows = conversation.workflowsRunning, workflows > 0 {
                Metric(symbol: Icon.workflow, text: Fmt.int(workflows))
                    .help(Fmt.count(workflows, "workflow en cours", "workflows en cours"))
            }
        }
        .font(.callout)
        .foregroundStyle(.secondary)
    }

    private func acceptedText(_ today: Int) -> String {
        let head = data.acceptedCapped ? "\(Fmt.int(today))+" : Fmt.int(today)
        guard let since = data.acceptedSince else { return head }
        return "\(head) / \(Fmt.int(since))"
    }

    private func acceptedHelp(_ today: Int) -> String {
        var text = "\(Fmt.int(today)) \(today > 1 ? "acceptées" : "acceptée") aujourd'hui"
        if let since = data.acceptedSince { text += " · \(Fmt.int(since)) depuis ton passage" }
        return text
    }
}

/// Icône + chiffre, sur une ligne.
struct Metric: View {
    let symbol: String
    let text: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: symbol)
                .symbolRenderingMode(.hierarchical)
                .imageScale(.small)
            Text(text)
                .monospacedDigit()
                .lineLimit(1)
        }
    }
}

/// Icône et texte serrés, icône centrée sur la première ligne.
struct CompactLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            configuration.icon
                .imageScale(.small)
                .frame(width: 14)
            configuration.title
        }
    }
}
