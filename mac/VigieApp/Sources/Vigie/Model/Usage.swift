import Foundation

/// GET /api/v2/usage/series?window=60|600|1200 (minutes) : consommation de chaque conversation.
struct UsageSeries: Decodable, Equatable, Sendable {
    @FlexDate var from: Date?
    @FlexDate var to: Date?
    var stepMin: Double?
    /// weekPct : % de la semaine du compte de la conversation.
    var unit: String?
    @Lossy var conversations: [UsageSeriesConversation]
    @Lossy var accounts: [UsageSeriesAccount]
}

struct UsageSeriesConversation: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var title: String?
    var project: String?
    var cwd: String?
    var accountId: String?
    var running: Bool?
    @Lossy var points: [UsagePoint]

    /// % de la semaine consommé sur toute la fenêtre.
    var totalPct: Double { points.reduce(0) { $0 + ($1.weekPct ?? 0) } }
    var totalTokens: Double { points.reduce(0) { $0 + ($1.tokens ?? 0) } }
}

struct UsageSeriesAccount: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var label: String?
    @Lossy var points: [UsagePoint]

    var totalPct: Double { points.reduce(0) { $0 + ($1.weekPct ?? 0) } }
}

struct UsagePoint: Decodable, Equatable, Sendable {
    @FlexDate var t: Date?
    var weekPct: Double?
    var tokens: Double?
}

/// Les trois fenêtres du graphique.
enum UsageSpan: Int, CaseIterable, Identifiable, Sendable {
    case hour = 60
    case tenHours = 600
    case twentyHours = 1200

    var id: Int { rawValue }

    var label: String {
        switch self {
        case .hour: "1 h"
        case .tenHours: "10 h"
        case .twentyHours: "20 h"
        }
    }

    /// Pas attendu du moteur (minutes), si la réponse ne le donne pas.
    var defaultStep: Double {
        switch self {
        case .hour: 1
        case .tenHours: 10
        case .twentyHours: 20
        }
    }
}
