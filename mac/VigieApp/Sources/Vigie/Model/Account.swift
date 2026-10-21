import Foundation

struct UsageWindow: Decodable, Equatable, Sendable {
    var label: String?
    var pct: Double?
    @FlexDate var resetsAt: Date?
}

struct AccountUsage: Decodable, Equatable, Sendable {
    @Tolerant var session: UsageWindow?
    @Tolerant var week: UsageWindow?
    @Tolerant var weekModel: UsageWindow?
    @FlexDate var observedAt: Date?
    /// session (relevé écrit par une vraie session) | ping (petite requête de relevé).
    var source: String?
}

/// AccountSummary (overview) et compte détaillé (GET /api/v2/accounts).
struct Account: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var label: String?
    var email: String?
    /// Adresse prévue pour ce compte ; `wrongAccount` = connecté avec une autre adresse.
    var expectedEmail: String?
    var wrongAccount: Bool?
    var connected: Bool?
    var isDefault: Bool?
    @Tolerant var usage: AccountUsage?
    var configDir: String?
    var keychainItem: String?
    var dirReady: Bool?

    var displayName: String { label ?? id }
    var isConnected: Bool { connected ?? false }
}

/// GET /api/v2/accounts
struct AccountsState: Decodable, Equatable, Sendable {
    @Lossy var accounts: [Account]
    var defaultForNew: String?
    @Tolerant var wrapper: WrapperState?
}

struct WrapperState: Decodable, Equatable, Sendable {
    var path: String?
    var active: Bool?
}
