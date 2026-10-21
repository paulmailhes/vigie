import Foundation

/// GET /api/v2/overview
struct Overview: Decodable, Equatable, Sendable {
    @FlexDate var now: Date?
    @Tolerant var settings: EngineSettings?
    @FlexDate var since: Date?
    @Tolerant var sinceSummary: SinceSummary?
    @Lossy var toReview: [ReviewItem]
    @Lossy var reports: [Report]
    @Lossy var accounts: [Account]
    @Lossy var conversations: [ConversationSummary]
    @Tolerant var engine: EngineInfo?
    /// Fil des dernières acceptations, toutes conversations (facultatif, plus récent d'abord).
    @Lossy var recentAccepted: [RecentAccepted]
}

/// Une acceptation du fil : quoi, dans quelle conversation, quand.
struct RecentAccepted: Decodable, Equatable, Sendable {
    @FlexDate var ts: Date?
    var kind: String?
    var title: String?
    var detail: String?
    var decision: String?
    var conversationId: String?
    var conversationTitle: String?
    var agent: String?
    var service: String?

    var itemKind: ItemKind { ItemKind(raw: kind) }
}

struct EngineSettings: Decodable, Equatable, Sendable {
    var autoAccept: Bool?
    var questionsAuto: Bool?
    var questionWaitMin: Int?
    var connectorsDefault: String?
    @Tolerant var guardRules: GuardSettings?

    enum CodingKeys: String, CodingKey {
        case autoAccept, questionsAuto, questionWaitMin, connectorsDefault
        case guardRules = "guard"
    }
}

struct GuardSettings: Decodable, Equatable, Sendable {
    var enabled: Bool?
    var waitMin: Int?
    /// vigie : refusée sur le moment, à autoriser une fois dans Vigie | vscode : fenêtre VS Code pendant waitMin.
    var mode: String?
    @Lossy var rules: [GuardRule]

    init(enabled: Bool? = nil, waitMin: Int? = nil, mode: String? = nil, rules: [GuardRule] = []) {
        self.enabled = enabled
        self.waitMin = waitMin
        self.mode = mode
        self.rules = rules
    }
}

struct GuardRule: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var label: String?
    var disabled: Bool?
}

struct SinceSummary: Decodable, Equatable, Sendable {
    var accepted: Int?
    var questionsAuto: Int?
    var blocked: Int?
    var reports: Int?
    var testsFailed: Int?
    var limits: Int?
}

enum ReviewKind: String, Sendable {
    case question, blocked, waiting, limit, other

    init(raw: String?) { self = raw.flatMap(ReviewKind.init(rawValue:)) ?? .other }
}

/// Un élément « À regarder ».
struct ReviewItem: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var kind: String?
    var conversationId: String?
    var conversationTitle: String?
    var title: String?
    var detail: String?
    @FlexDate var ts: Date?
    @Tolerant var question: ReviewQuestion?
    /// Action sensible (kind = blocked) : waiting = la conversation attend ta décision ; blocked = refusée.
    var state: String?
    @FlexString var pendingId: String?
    @FlexDate var expiresAt: Date?
    var rule: String?
    var command: String?
    var byAgent: String?
    var cwd: String?
    var needsPassword: Bool?
    /// Mode « seulement par Vigie » (state = awaiting) : identifiant pour POST /api/v2/approvals.
    @FlexString var approvalId: String?

    var reviewKind: ReviewKind { ReviewKind(raw: kind) }

    /// La conversation attend encore ta décision (autoriser ou refuser depuis l'app).
    var isPendingDecision: Bool { state == "waiting" && pendingId != nil }

    /// Refusée sur le moment, attend ton accord dans Vigie (autoriser une fois, pour cette commande exacte).
    var isAwaitingApproval: Bool { state == "awaiting" && approvalId != nil }

    /// Une décision t'attend : dans VS Code (pendingId) ou dans Vigie (approvalId).
    var needsDecision: Bool { isPendingDecision || isAwaitingApproval }

    /// Identifiant à utiliser dans POST /api/v2/questions/:id/review.
    var questionID: String {
        if let id = question?.id, !id.isEmpty { return id }
        return id.hasPrefix("q:") ? String(id.dropFirst(2)) : id
    }
}

struct ReviewQuestion: Decodable, Equatable, Sendable {
    var id: String?
    @Lossy var items: [QuestionItem]
}

struct QuestionItem: Decodable, Equatable, Sendable {
    var question: String?
    var header: String?
    var multiSelect: Bool?
    @Lossy var options: [QuestionOption]
    @Tolerant var chosen: StringList?

    var chosenLabels: [String] { chosen?.values ?? [] }
    var key: String { question ?? header ?? "" }
}

struct QuestionOption: Decodable, Equatable, Sendable {
    var label: String?
    var description: String?
}

enum ReportKind: String, Sendable {
    case artifact, missionDone, workflowDone, other

    init(raw: String?) { self = raw.flatMap(ReportKind.init(rawValue:)) ?? .other }
}

struct Report: Decodable, Equatable, Sendable {
    var kind: String?
    var conversationId: String?
    var conversationTitle: String?
    var title: String?
    var detail: String?
    var url: String?
    @FlexDate var ts: Date?

    var reportKind: ReportKind { ReportKind(raw: kind) }

    /// Clé stable pour l'affichage (le contrat ne donne pas d'identifiant).
    var stableKey: String {
        [kind ?? "", conversationId ?? "", url ?? "", title ?? "", ts.map { String($0.timeIntervalSince1970) } ?? ""]
            .joined(separator: "|")
    }
}

struct EngineInfo: Decodable, Equatable, Sendable {
    var indexing: Bool?
    var wrapperActive: Bool?
    /// Messages courts du moteur (texte, ou objet avec text / message / title).
    @Lossy var notices: [EngineNotice]
}

struct EngineNotice: Decodable, Equatable, Sendable {
    var text: String

    private enum Keys: String, CodingKey { case text, message, title }

    init(from decoder: any Decoder) throws {
        if let single = try? decoder.singleValueContainer(), let value = try? single.decode(String.self) {
            text = value
            return
        }
        let container = try decoder.container(keyedBy: Keys.self)
        guard let value = (try? container.decode(String.self, forKey: .text))
            ?? (try? container.decode(String.self, forKey: .message))
            ?? (try? container.decode(String.self, forKey: .title)) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "avis vide"))
        }
        text = value
    }
}
