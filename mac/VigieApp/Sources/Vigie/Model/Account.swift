import Foundation

struct UsageWindow: Decodable, Equatable, Sendable {
    var label: String?
    var pct: Double?
    @FlexDate var resetsAt: Date?
    /// Semaine seulement : quand elle serait pleine au rythme des dernières 24 h (au quart d'heure). nil : elle tient
    /// jusqu'à la remise à zéro, ou pas de quoi mesurer (moteur plus ancien compris).
    @FlexDate var fullAt: Date?
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
    /// Les autres comptes de Vigie connectés au même compte claude.ai (doublon : le navigateur était connecté au
    /// mauvais compte au moment de la connexion).
    var sameAs: [String]?
    var connected: Bool?
    var isDefault: Bool?
    @Tolerant var usage: AccountUsage?
    var configDir: String?
    var keychainItem: String?
    var dirReady: Bool?

    /// « codex » : le compte ChatGPT de Codex (relevé dans ses fils, pas de connexion gérée par Vigie).
    var kind: String?
    /// Forfait (Codex).
    var plan: String?
    /// Codex : le hook de Vigie (branché, approuvé dans Codex, vu en action) et la connexion en cours.
    @Tolerant var hook: CodexHook?
    var connecting: Bool?

    var displayName: String { label ?? id }
    var isConnected: Bool { connected ?? false }
    var isCodex: Bool { kind == "codex" }
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

struct CodexHook: Decodable, Equatable, Sendable {
    var installed: Bool?
    var trusted: Bool?
    @FlexDate var seenAt: Date?
}
