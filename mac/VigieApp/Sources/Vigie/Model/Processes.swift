import Foundation

/// GET /api/v2/processes : ce que les conversations ont laissé tourner (outil « En fond »).
struct BackgroundList: Decodable, Equatable, Sendable {
    @FlexDate var scannedAt: Date?
    @Tolerant var total: BackgroundTotal?
    @Tolerant var forgotten: BackgroundTotal?
    var autoStop: Bool?
    @Lossy var autoStopped: [AutoStopped]
    @Lossy var groups: [BackgroundGroup]
}

struct BackgroundTotal: Decodable, Equatable, Sendable {
    var groups: Int?
    var processes: Int?
    var memoryMb: Double?
}

enum BackgroundState: String, Sendable {
    /// Sa conversation est fermée : un oubli.
    case forgotten
    /// Une app ouverte par un agent (Docker…) : tu peux la vouloir, elle se quitte comme avec ⌘Q.
    case app
    case working, waiting, idle, unknown

    init(raw: String?) { self = raw.flatMap(BackgroundState.init(rawValue:)) ?? .unknown }

    /// La conversation travaille encore : l'arrêter peut casser son travail.
    var conversationBusy: Bool { self == .working || self == .waiting }
}

/// Une chose qui tourne en fond : un processus et sa descendance (un Chrome et ses enfants = une ligne), ou une app.
struct BackgroundGroup: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    /// chrome, render, server, tests, watch, db, app, command.
    var kind: String?
    var label: String?
    var detail: String?
    @Lossy var ports: [Int]
    var processes: Int?
    var memoryMb: Double?
    /// Mémoire réelle (macOS), sinon estimée.
    var memoryReal: Bool?
    var cpu: Double?
    @FlexDate var startedAt: Date?
    var state: String?
    @FlexDate var forgottenSince: Date?
    var conversationId: String?
    var conversationTitle: String?
    var project: String?
    var cwd: String?
    var command: String?
    /// Une app : son paquet (.app), pour la quitter.
    var bundle: String?

    var groupState: BackgroundState { BackgroundState(raw: state) }
}

struct AutoStopped: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    @FlexDate var ts: Date?
    var label: String?
    var project: String?
    var processes: Int?
    var memoryMb: Double?
}

/// Vue d'ensemble : le résumé du dernier relevé (barre latérale, barre des menus, notifications).
struct BackgroundSummary: Decodable, Equatable, Sendable {
    @FlexDate var scannedAt: Date?
    var forgotten: Int?
    var forgottenProcesses: Int?
    var forgottenMb: Double?
    var groups: Int?
    @Lossy var forgottenLabels: [String]
    @Lossy var autoStopped: [AutoStopped]
}

/// Ce qu'une conversation a en fond (puce de sa page).
struct ConversationBackground: Decodable, Equatable, Sendable {
    var count: Int?
    var memoryMb: Double?
    var label: String?
    var state: String?
}
