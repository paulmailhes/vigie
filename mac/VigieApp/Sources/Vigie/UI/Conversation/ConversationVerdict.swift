import Foundation

/// Ce que dit la tuile d'État, en un mot et une couleur : le premier verdict qui s'applique.
/// Rouge : à autoriser, t'attend, à relancer, arrêtée. Orange : s'emballe, sans nouvelles. Vert : travaille, en pause.
/// Gris : finie, au repos, fermée.
struct ConversationVerdict: Equatable {
    enum Tone: Equatable { case live, warn, alert, calm }

    var tone: Tone
    var title: String
    /// « depuis 6 min », « il y a 3 min » : à côté du mot.
    var since: String?
    /// Ligne 2 : ce qu'elle fait, ce qu'elle attend, pourquoi elle s'est arrêtée, ce qu'elle a fait.
    var line: String?
    /// Ce qui t'attend (décisions, questions) : chaque élément avec ses boutons.
    var items: [ReviewItem] = []
    /// Bouton qui ramène à la conversation dans son outil (rien à décider d'ici).
    var openButton = false
    /// Le bouton dit « Répondre dans… » (elle attend un message de toi) ; sinon « Ouvrir dans… ».
    var reply = true
    /// Une tuile orange porte aussi de quoi comprendre : « Voir les tests » (un test en échec), sinon « Journal ».
    var showCause = false

    /// Sans nouvelles : marquée en cours, mais rien écrit depuis 10 min et rien ne tourne pour elle.
    static let silence: TimeInterval = 10 * 60

    /// `urgent` : « À décider » de cette conversation (`store.decisionItems(for:)`, triée par échéance).
    static func make(summary s: ConversationSummary, detail: ConversationDetail?, urgent: [ReviewItem], now: Date,
                     accountName: (String?) -> String) -> ConversationVerdict {
        let decisions = urgent.filter(\.needsDecision)
        if !decisions.isEmpty {
            return .init(tone: .alert, title: "À autoriser", line: nil, items: decisions)
        }
        let messages = detail?.messages ?? []
        let lastAsk = messages.last?.ask
        let waiting = urgent.filter { $0.reviewKind == .waiting }
        if s.state == .waiting || s.state == .blocked || !waiting.isEmpty {
            let question = waiting.first { $0.id.hasPrefix("w:") }?.title
            let line = question.map { "« \($0) »" } ?? s.waitingFor ?? lastAsk.map { "« \($0) »" } ?? "Elle attend ta réponse"
            let answerable = waiting.filter { !$0.questions.isEmpty && $0.pendingId != nil }
            return .init(tone: .alert, title: "T'attend", since: since(s.lastActivity, now: now), line: line,
                         items: answerable, openButton: answerable.isEmpty)
        }
        if let resume = s.resume {
            return .init(tone: .alert, title: "À relancer",
                         line: "Arrêtée pour passer sur \(accountName(resume.to)) : écris-lui un message (« continue »), elle repart dessus.",
                         openButton: true)
        }
        let agents = s.agentsRunning ?? 0, workflows = s.workflowsRunning ?? 0
        let commands = detail?.background.count ?? 0
        let busy = agents > 0 || workflows > 0 || commands > 0
        if s.state != .working, !busy, let ended = detail?.ended, ended.kind == "limit" || ended.kind == "error" {
            return .init(tone: .alert, title: ended.kind == "limit" ? "Arrêtée : limite atteinte" : "Arrêtée : erreur de l'API",
                         since: ago(ended.ts, now: now), line: unfinishedLine(detail), openButton: true)
        }
        // une tuile orange porte son action : de quoi rouvrir la conversation, et de quoi comprendre
        if let alert = s.alert, alert.isRunaway {
            return .init(tone: .warn, title: "S'emballe", line: alert.reason ?? "Elle consomme beaucoup plus que d'habitude",
                         openButton: true, reply: false, showCause: true)
        }
        if s.state == .working {
            if !busy, let last = s.lastActivity, now.timeIntervalSince(last) > silence {
                let line = currentStep(detail).map { "\($0) marquée en cours, dernière action \(at(last, now: now))" }
                    ?? "Dernière action \(at(last, now: now))"
                return .init(tone: .warn, title: "Sans nouvelles", since: "depuis \(Fmt.age(since: last, now: now))",
                             line: line, openButton: true, reply: false, showCause: true)
            }
            return .init(tone: .live, title: "Travaille", line: workLine(s, detail))
        }
        if busy {
            var parts: [String] = []
            if workflows > 0 { parts.append(Fmt.count(workflows, "workflow")) }
            if agents > 0 { parts.append(Fmt.count(agents, "agent")) }
            if commands > 0 { parts.append(Fmt.count(commands, "commande de fond", "commandes de fond")) }
            let verb = agents + workflows + commands > 1 ? "tournent" : "tourne"
            return .init(tone: .live, title: "En pause", line: "Au repos, mais \(parts.joined(separator: " et ")) \(verb) : elle reprendra seule.")
        }
        let report = messages.last(where: \.isReport)
        if s.state == .closed {
            return .init(tone: .calm, title: "Fermée", since: ago(s.lastActivity, now: now), line: report?.brief ?? s.headline)
        }
        if let report {
            return .init(tone: .calm, title: "Finie", since: ago(report.ts, now: now), line: report.brief ?? s.headline)
        }
        return .init(tone: .calm, title: "Au repos", since: ago(s.lastActivity, now: now), line: s.headline)
    }

    /// Ce qu'elle fait : l'étape du plan et ses agents, sinon son dernier message, sinon son résumé.
    private static func workLine(_ s: ConversationSummary, _ detail: ConversationDetail?) -> String? {
        var parts: [String] = []
        if let step = currentStep(detail) { parts.append(step) }
        let agents = s.agentsRunning ?? 0
        if agents > 0 { parts.append("\(Fmt.count(agents, "agent")) au travail") }
        if !parts.isEmpty { return parts.joined(separator: " · ") }
        if let live = detail?.messages.last?.brief { return live }
        return s.headline
    }

    private static func currentStep(_ detail: ConversationDetail?) -> String? {
        guard let plan = detail?.now?.plan, let index = plan.currentIndex else { return nil }
        return plan.steps[index].label
    }

    /// « Pas finie : 23/29 · en cours : L2.24 Icônes de fin de partie ».
    private static func unfinishedLine(_ detail: ConversationDetail?) -> String {
        guard let plan = detail?.now?.plan, !plan.steps.isEmpty else { return "Pas finie" }
        var text = "Pas finie : \(plan.doneCount)/\(plan.totalCount)"
        if let step = currentStep(detail) { text += " · en cours : \(step)" }
        return text
    }

    private static func ago(_ date: Date?, now: Date) -> String? {
        date.map { Fmt.ago($0, now: now) }
    }

    private static func since(_ date: Date?, now: Date) -> String? {
        date.map { "depuis \(Fmt.age(since: $0, now: now))" }
    }

    // MARK: Textes de la page

    /// Un fait passé après un verbe : « à 01:15 » aujourd'hui, « hier 23:10 », « lun. 26 oct. 20:00 » (jamais l'heure
    /// seule : le matin, on ne saurait pas si c'était cette nuit ou la veille).
    static func at(_ date: Date?, now: Date) -> String {
        guard let date else { return "" }
        return Calendar.current.isDate(date, inSameDayAs: now) ? "à \(Fmt.time(date))" : Fmt.when(date, now: now)
    }

    /// Une ligne seule commence par une majuscule (un fragment après « · » reste en minuscule).
    static func sentence(_ text: String) -> String {
        text.prefix(1).uppercased() + text.dropFirst()
    }
}
