import SwiftUI

// Vue d'ensemble, la liste « Conversations » : une rangée chacune (état, ce qu'elle fait, compte, débit, avancée),
// dans l'ordre stable de la liste (par nom : l'activité ne déplace rien). Les décisions sont toutes en tête de page,
// dans « À décider » : la rangée garde seulement sa pastille (« À autoriser », « T'attend »). Sous une conversation
// finie depuis moins de 24 h, son compte rendu : ce que Claude a fait, son verdict et ses faits, « À toi : … », sa
// question.

extension VigieStore {
    /// Compte sur lequel tourne vraiment la conversation (processus lancé), sinon celui choisi.
    func runningAccountId(of conversation: ConversationSummary) -> String? {
        conversation.account?.running ?? conversation.accountId ?? account(nil)?.id
    }

    /// Conversations ouvertes qui travaillent sur ce compte, dans l'ordre de la liste.
    func working(on accountId: String) -> [ConversationSummary] {
        conversations.filter { $0.isOpen && $0.state == .working && runningAccountId(of: $0) == accountId }
    }

    /// Débit du moment sur ce compte (% de sa semaine par heure, 10 dernières minutes).
    func ratePerHour(on accountId: String) -> Double {
        conversations
            .filter { $0.isOpen && runningAccountId(of: $0) == accountId }
            .reduce(0) { $0 + ($1.rate?.weekPctPerHour ?? 0) }
    }

    /// Le compte rendu d'une conversation finie : au repos, rien ne tourne pour elle, sa dernière demande a fini il y
    /// a moins de 24 h et rien ne s'est passé depuis (une nouvelle demande, même courte, le rend caduc).
    func finishedReport(for conversation: ConversationSummary) -> Report? {
        guard conversation.state == .idle,
              (conversation.agentsRunning ?? 0) == 0, (conversation.workflowsRunning ?? 0) == 0 else { return nil }
        let ends = reports.map(\.value).filter { $0.reportKind == .missionDone && $0.conversationId == conversation.id }
        guard let last = ends.max(by: { ($0.ts ?? .distantPast) < ($1.ts ?? .distantPast) }), let ts = last.ts,
              now.timeIntervalSince(ts) < 24 * 3600 else { return nil }
        if let activity = conversation.lastActivity, activity.timeIntervalSince(ts) > 10 * 60 { return nil }
        return last
    }
}

/// Rangées séparées par un filet, dans un seul fond arrondi.
struct RowsBlock<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) {
            Group(subviews: content) { rows in
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    if index > 0 { Divider().padding(.leading, 40) }
                    row
                }
            }
        }
        .background(.quinary, in: .rect(cornerRadius: Theme.corner))
    }
}

// MARK: - Conversations

struct ConversationListSection: View {
    @Environment(VigieStore.self) private var store

    var body: some View {
        let open = store.conversations.filter(\.isOpen)
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader("Conversations", count: open.count) {
                if open.filter({ !$0.isCodex }).count > 1 {
                    SwitchAllMenu()
                }
            }
            if open.isEmpty {
                Label("Aucune conversation ouverte", systemImage: "moon.zzz")
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
            } else {
                RowsBlock {
                    ConversationListHeader()
                    ForEach(open) { conversation in
                        // la conversation, et sous celle qui a fini, son compte rendu
                        VStack(alignment: .leading, spacing: 0) {
                            ConversationListRow(conversation: conversation,
                                                data: CardData(summary: conversation, detail: store.details[conversation.id]?.raw,
                                                               since: store.since, now: store.now))
                            if let report = store.finishedReport(for: conversation) {
                                FinishedReportRow(conversation: conversation, report: report)
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Passer toutes les conversations ouvertes sur un même compte, en une fois (par exemple celui qui a encore des crédits).
struct SwitchAllMenu: View {
    @Environment(VigieStore.self) private var store
    @State private var target: Account?
    @State private var busy = false

    var body: some View {
        Menu {
            Text("Passer les conversations ouvertes sur")
            ForEach(store.accounts.filter(\.isConnected)) { account in
                let count = store.conversationsToSwitch(to: account.id).count
                Button(count > 0 ? "\(account.displayName) (\(Fmt.count(count, "conversation")))" : "\(account.displayName) (toutes y sont)") {
                    target = account
                }
                .disabled(count == 0)
            }
        } label: {
            BusyLabel(busy: busy) { Label("Tout passer sur…", systemImage: "arrow.left.arrow.right") }
        }
        .menuStyle(.button)
        .fixedSize()
        .glassButton()
        .help("Change le compte Claude de toutes les conversations ouvertes en une fois")
        .confirmationDialog(title, isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }),
                            titleVisibility: .visible, presenting: target) { account in
            if working(account) > 0 {
                Button("À la fin de leur travail") { run(account, now: false) }
                Button("Tout de suite (interrompt celles qui travaillent)") { run(account, now: true) }
            } else {
                Button("Passer sur \(account.displayName)") { run(account, now: false) }
            }
            Button("Annuler", role: .cancel) {}
        } message: { account in
            Text(message(account))
        }
    }

    private var title: String {
        guard let target else { return "" }
        let count = store.conversationsToSwitch(to: target.id).count
        return "Passer \(Fmt.count(count, "conversation")) sur \(target.displayName) ?"
    }

    private func working(_ account: Account) -> Int {
        store.conversationsToSwitch(to: account.id).count { $0.state == .working }
    }

    private func message(_ account: Account) -> String {
        let count = working(account)
        var text = "Chacune garde tout son historique. Celles au repos repartent sur ce compte à ton prochain message."
        if count > 0 { text += " \(Fmt.count(count, "travaille", "travaillent")) en ce moment." }
        return text
    }

    private func run(_ account: Account, now: Bool) {
        busy = true
        Task { @MainActor in
            await store.switchAllConversations(to: account.id, now: now)
            busy = false
        }
    }
}

/// Largeurs des colonnes de droite, communes à l'en-tête et aux rangées.
private enum Column {
    static let account: CGFloat = 96
    static let rate: CGFloat = 112
    static let steps: CGFloat = 56
}

struct ConversationListHeader: View {
    var body: some View {
        HStack(spacing: 12) {
            Text("")
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("Compte")
                .frame(width: Column.account, alignment: .trailing)
                .help("Le compte Claude sur lequel elle tourne")
            Text("% semaine/h")
                .frame(width: Column.rate, alignment: .trailing)
                .help("Consommation du moment : part de la semaine du compte par heure (10 dernières minutes), puis ce qu'elle a pris de la semaine")
            Text("Avancée")
                .frame(width: Column.steps, alignment: .trailing)
                .help("Étapes faites du plan, sinon tâches faites de sa liste")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .padding(.bottom, 2)
    }
}

/// Une conversation : pastille, nom, ce qui est à surveiller et ce qu'elle fait ; sa pastille si elle t'attend ;
/// compte, débit, avancée.
struct ConversationListRow: View {
    @Environment(VigieStore.self) private var store
    let conversation: ConversationSummary
    let data: CardData

    @State private var hovering = false

    private var working: Bool { conversation.state == .working }

    var body: some View {
        HStack(spacing: 12) {
            StatusDot(status: conversation.state, size: 9)
                .frame(width: 14)
            VStack(alignment: .leading, spacing: 2) {
                Text(conversation.shortTitle)
                    .textRole(.item)
                    .lineLimit(1)
                detailLine
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .help(detailHelp)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            attention
            accountCell
                .frame(width: Column.account, alignment: .trailing)
            rateCell
                .frame(width: Column.rate, alignment: .trailing)
            Text(data.hasProgress ? "\(data.progressDone)/\(data.progressTotal)" : "")
                .font(.callout)
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(width: Column.steps, alignment: .trailing)
                .help(data.progressHelp)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(hovering ? AnyShapeStyle(.quaternary.opacity(0.5)) : AnyShapeStyle(.clear))
        .contentShape(.rect)
        .onHover { hovering = $0 }
        .onTapGesture { store.route = .conversation(conversation.id) }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("\(conversation.shortTitle), \(Theme.label(for: conversation.state))")
        .accessibilityAction { store.route = .conversation(conversation.id) }
    }

    /// Ce qu'elle fait : l'étape en cours, sinon le dernier résumé, sinon son état.
    private var line: String {
        if let current = data.current, !current.isEmpty { return current }
        if let headline = conversation.headline, !headline.isEmpty { return headline }
        return Theme.label(for: conversation.state)
    }

    /// À surveiller, écrit en mots (pas seulement en icônes) et en tête de ligne, pour ne jamais être coupé avant
    /// l'étape : « s'emballe » et les tests en échec en orange, les agents au travail en gris.
    private var warnings: [(text: String, symbol: String, warn: Bool)] {
        var list: [(text: String, symbol: String, warn: Bool)] = []
        if let alert = conversation.alert, alert.isRunaway {
            list.append(("s'emballe", Icon.runaway, true))
        }
        if data.testsFailed > 0 {
            list.append((Fmt.count(data.testsFailed, "test en échec", "tests en échec"), Icon.testFailed, true))
        }
        if let agents = conversation.agentsRunning, agents > 0 {
            list.append((Fmt.count(agents, "agent"), Icon.agent, false))
        }
        return list
    }

    private var detailLine: Text {
        let parts: [Text] = warnings.map { warning in
            let text = Text("\(Image(systemName: warning.symbol)) \(warning.text)")
            return warning.warn ? text.foregroundStyle(Theme.warnText) : text
        } + [Text(line)]
        return parts.dropFirst().reduce(parts[0]) { Text("\($0) \(Text("·").foregroundStyle(.tertiary)) \($1)") }
    }

    private var detailHelp: String {
        var parts = warnings.map(\.text)
        if let alert = conversation.alert, alert.isRunaway, let reason = alert.reason, !reason.isEmpty {
            parts[0] = "s'emballe (\(reason))"
        }
        return (parts + [line]).joined(separator: " · ")
    }

    /// Sa pastille quand elle t'attend (la décision elle-même est en tête de page, dans « À décider »).
    @ViewBuilder
    private var attention: some View {
        let decisions = store.decisionItems(for: conversation.id)
        if let resume = conversation.resume {
            Chip("À relancer", symbol: "arrow.clockwise", tone: .alert) {
                Task { await store.openConversationInVSCode(conversation.id, cwd: conversation.cwd) }
            }
            .help("Arrêtée pour passer sur \(store.account(resume.to)?.displayName ?? "l'autre compte") : écris-lui un message dans VS Code et elle repart dessus. Clic : ouvrir dans VS Code.")
        } else if let sensitive = decisions.first(where: { $0.reviewKind == .blocked }) {
            Chip("À autoriser", symbol: Icon.guardRule, tone: .alert) {
                store.blockedRequest = sensitive
            }
            .help("\(sensitive.title ?? sensitive.rule ?? "Action sensible") : voir l'action en entier")
        } else if !decisions.isEmpty || conversation.state == .waiting {
            Chip("T'attend", symbol: Icon.waiting, tone: .alert)
                .help(conversation.waitingFor ?? decisions.first?.title ?? "T'attend")
        } else if conversation.state == .blocked {
            Chip("À autoriser", symbol: Icon.guardRule, tone: .alert)
        }
    }

    @ViewBuilder
    private var accountCell: some View {
        let running = conversation.resume?.to ?? store.runningAccountId(of: conversation)
        let pending = conversation.account?.pending?.to
        VStack(alignment: .trailing, spacing: 1) {
            Text(store.account(running)?.displayName ?? running ?? Fmt.none)
                .foregroundStyle(working ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
            if let pending, pending != running {
                Text("→ \(store.account(pending)?.displayName ?? pending)")
                    .font(.caption)
                    .foregroundStyle(Theme.warnText)
            }
        }
        .font(.callout)
        .lineLimit(1)
        .help(pending.map { "Tourne sur \(store.account(running)?.displayName ?? "?"), passe sur \(store.account($0)?.displayName ?? $0) à la fin de son tour" }
              ?? "Tourne sur \(store.account(running)?.displayName ?? "?")")
    }

    /// Le débit du moment, et dessous ce qu'elle a pris de la semaine de son compte (« 14 % de la semaine »).
    private var rateCell: some View {
        VStack(alignment: .trailing, spacing: 1) {
            if let rate = conversation.rate, (rate.tokensPerMin ?? 0) > 0 || (rate.weekPctPerHour ?? 0) > 0.005 {
                RateBadge(rate: rate, alert: conversation.alert?.isRunaway == true, compact: true, live: working)
            }
            if let share = Self.weekShare(conversation.weekPct) {
                Text(share)
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .help("Part de la semaine de son compte qu'elle a consommée depuis le début de la semaine")
            }
        }
    }

    /// « 14 % de la semaine », « < 1 % de la semaine » ; rien sans relevé (jamais « — » dans la colonne).
    static func weekShare(_ pct: Double?) -> String? {
        guard let pct, pct > 0 else { return nil }
        return pct < 1 ? "< 1 % de la semaine" : "\(Fmt.pct(pct.rounded())) de la semaine"
    }
}

/// Sous une conversation finie depuis moins de 24 h : ce que Claude a fait, son verdict et ses faits, sa durée et son
/// heure, « À toi : … » en gras, la question qui finit le compte rendu, puis « Voir » et « Répondre dans VS Code ».
struct FinishedReportRow: View {
    @Environment(VigieStore.self) private var store
    let conversation: ConversationSummary
    let report: Report

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(report.title ?? "Demande terminée")
                .textRole(.event)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .help(report.prompt.map { "Ta demande : \($0)" } ?? report.title ?? "")
            let facts = factsLine
            if !facts.plain.isEmpty {
                facts.text
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(facts.plain)
            }
            if let toYou = report.toYou, !toYou.isEmpty {
                Text("À toi : \(toYou)")
                    .font(.body.weight(.semibold))
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let question = report.question, !question.isEmpty {
                Label {
                    Text(question)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: Icon.question)
                        .foregroundStyle(.secondary)
                }
                .help("Claude finit son compte rendu par cette question")
            }
            HStack(spacing: 6) {
                Button("Voir") { store.route = .conversation(conversation.id) }
                    .glassButton()
                    .help("Voir la conversation dans Vigie")
                AsyncButton(conversation.replyLabel) {
                    await store.openConversationInVSCode(conversation.id, cwd: conversation.cwd)
                }
                .glassButton()
                .help("Ouvre cette conversation dans VS Code")
            }
            .controlSize(.small)
            .fixedSize()
            .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 40)
        .padding(.trailing, 14)
        .padding(.bottom, 12)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Compte rendu de \(conversation.shortTitle)")
    }

    // MARK: Ligne de faits

    /// Le verdict de la demande : celui de la conversation (jusqu'à maintenant), sinon celui du compte rendu.
    private var checks: RequestChecks? { conversation.checks ?? report.checks }

    /// Le verdict en couleur en tête (il ne se coupe jamais), puis ce qui reste à commiter ou envoyer, les autres
    /// faits, la durée et l'heure, séparés par « · ». Le texte entier pour le survol.
    private var factsLine: (text: Text, plain: String) {
        let verdict = Self.verdict(checks)
        let duration = report.durationMs.map { Fmt.duration(ms: $0) }.flatMap { $0.isEmpty ? nil : "a pris \($0)" }
        let others = Self.facts(detail: report.detail, checks: checks)
            + [duration, Fmt.when(report.ts, now: store.now)].compactMap { $0?.isEmpty == false ? $0 : nil }
        var parts: [Text] = []
        if let verdict {
            let text = Text("\(Image(systemName: verdict.symbol)) \(verdict.text)")
            parts.append(verdict.color.map { text.foregroundStyle($0) } ?? text)
        }
        parts += others.map { Text($0) }
        guard let first = parts.first else { return (Text(verbatim: ""), "") }
        let line = parts.dropFirst().reduce(first) { Text("\($0) \(Text("·").foregroundStyle(.tertiary)) \($1)") }
        return (line, ([verdict?.text] + others).compactMap { $0 }.joined(separator: " · "))
    }

    /// Le verdict à afficher : sa phrase, son icône et sa couleur de texte. Réussi en gris avec une coche (le vert veut
    /// dire « travaille », pas « réussi ») ; modifié après les tests ou aucun test lancé en orange ; en échec en rouge.
    static func verdict(_ checks: RequestChecks?) -> (text: String, symbol: String, color: Color?)? {
        guard let label = checks?.label?.trimmingCharacters(in: .whitespaces), !label.isEmpty else { return nil }
        switch checks?.verdictKind ?? .unknown {
        case .verified: return (label, Icon.verified, nil)
        case .changedAfterTests, .noTests: return (label, Icon.unverified, Theme.warnText)
        case .testsFailed: return (label, Icon.testFailed, Theme.alertText)
        case .unknown: return nil
        }
    }

    /// Les faits du compte rendu (« 3 commits · modifié après les tests · déployé »), sans ce que le verdict dit
    /// déjà, et ses notes en tête (« 3 fichiers modifiés après le dernier commit »).
    static func facts(detail: String?, checks: RequestChecks?) -> [String] {
        let parts = (detail ?? "").components(separatedBy: " · ")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard let checks else { return parts }
        let notes = checks.notes.filter { !$0.isEmpty }
        let shown = verdict(checks) != nil ? [checks.label ?? ""] : []
        let said = Set((shown + notes).map { $0.lowercased() })
        return notes + parts.filter { !said.contains($0.lowercased()) }
    }
}
