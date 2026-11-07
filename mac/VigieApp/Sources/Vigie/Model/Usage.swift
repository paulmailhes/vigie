import Foundation

/// GET /api/v2/usage/series?window=60|600|1440|2880 (minutes) : consommation de chaque conversation, ouverte ou fermée
/// pendant la fenêtre (le moteur garde 48 h).
struct UsageSeries: Decodable, Equatable, Sendable {
    @FlexDate var from: Date?
    @FlexDate var to: Date?
    var stepMin: Double?
    /// weekPct : % de la semaine du compte de la conversation.
    var unit: String?
    @Lossy var conversations: [UsageSeriesConversation]
    @Lossy var accounts: [UsageSeriesAccount]

    /// La fenêtre couverte, de `from` à `to` (nil si le moteur ne la donne pas).
    var window: ClosedRange<Date>? {
        guard let from, let to, from <= to else { return nil }
        return from...to
    }
}

struct UsageSeriesConversation: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var title: String?
    var project: String?
    var cwd: String?
    var accountId: String?
    var running: Bool?
    /// Dernière activité (fermée : à peu près l'heure où elle s'est arrêtée).
    @FlexDate var lastActivity: Date?
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

/// Les quatre fenêtres du graphique (60 points chacune).
enum UsageSpan: Int, CaseIterable, Identifiable, Sendable {
    case hour = 60
    case tenHours = 600
    case day = 1440
    case twoDays = 2880

    var id: Int { rawValue }

    /// La fenêtre retenue dans les réglages (`usage.window`). Une valeur qui n'est plus proposée prend la plus petite
    /// fenêtre qui la couvre : l'ancienne fenêtre de 20 h (1200, Vigie 0.3.28 et avant) devient 24 h.
    init(stored raw: Int) {
        self = UsageSpan(rawValue: raw) ?? Self.allCases.first { $0.rawValue >= raw } ?? .twoDays
    }

    var label: String {
        switch self {
        case .hour: "1 h"
        case .tenHours: "10 h"
        case .day: "24 h"
        case .twoDays: "48 h"
        }
    }

    /// Pas attendu du moteur (minutes), si la réponse ne le donne pas.
    var defaultStep: Double { Double(rawValue) / 60 }

    /// Sur 24 h et 48 h, une même heure revient d'un jour à l'autre : l'axe et l'infobulle disent aussi le jour.
    var spansDays: Bool { rawValue > 600 }
}
