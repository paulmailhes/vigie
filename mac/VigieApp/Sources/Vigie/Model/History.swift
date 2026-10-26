import SwiftUI

/// GET /api/v2/history : une ligne par issue, la plus récente d'abord, et le nombre de lignes par statut.
struct HistoryPage: Decodable, Equatable, Sendable {
    var window: Int?
    @Lossy var items: [HistoryItem]
    var counts: [String: Int]?
}

struct HistoryItem: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    @FlexDate var ts: Date?
    var status: String
    var event: String?
    var app: String?
    var tool: String?
    var title: String?
    var command: String?
    var rule: String?
    var reason: String?
    var conversationId: String?
    var conversationTitle: String?
    var project: String?
    var cwd: String?
    var agent: String?
    var needsPassword: Bool?

    var historyStatus: HistoryStatus { HistoryStatus(rawValue: status) ?? .accepted }
    var isCodex: Bool { app == "codex" }
    /// Elle n'est pas passée : on peut la relancer (message à coller) ou la faire soi-même.
    var didNotRun: Bool { [.blocked, .refused, .failed].contains(historyStatus) }
}

/// Issue d'une demande, dans l'ordre des filtres.
enum HistoryStatus: String, CaseIterable, Identifiable, Sendable {
    case accepted, refused, blocked, failed, question, vscode, waiting

    var id: String { rawValue }

    var title: String {
        switch self {
        case .accepted: "Acceptées"
        case .refused: "Refusées"
        case .blocked: "Bloquées"
        case .failed: "Échouées"
        case .question: "Questions"
        case .vscode: "Laissées à VS Code"
        case .waiting: "En attente"
        }
    }

    var label: String {
        switch self {
        case .accepted: "Acceptée"
        case .refused: "Refusée"
        case .blocked: "Bloquée"
        case .failed: "Échouée"
        case .question: "Question"
        case .vscode: "Laissée à VS Code"
        case .waiting: "En attente"
        }
    }

    var symbol: String {
        switch self {
        case .accepted: "checkmark.circle.fill"
        case .refused: "xmark.circle.fill"
        case .blocked: "hand.raised.fill"
        case .failed: "exclamationmark.triangle.fill"
        case .question: "questionmark.bubble.fill"
        case .vscode: "chevron.left.forwardslash.chevron.right"
        case .waiting: "hourglass"
        }
    }

    var color: Color {
        switch self {
        case .accepted: .green
        case .refused: .secondary
        case .blocked, .failed: .red
        case .question: .blue
        case .vscode: .secondary
        case .waiting: .orange
        }
    }
}
