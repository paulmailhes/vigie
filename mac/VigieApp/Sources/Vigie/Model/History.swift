import SwiftUI

/// GET /api/v2/history : une ligne par issue, la plus récente d'abord, et le nombre de lignes par statut.
struct HistoryPage: Decodable, Equatable, Sendable {
    var window: Int?
    @Lossy var items: [HistoryItem]
    var counts: [String: Int]?

    /// Les filtres du moteur, pour les données d'exemple (un seul history.json pour toutes les requêtes) : la période,
    /// la conversation et la recherche, puis les compteurs, puis l'issue (les puces gardent leurs chiffres).
    func filtered(window: Int, status: String?, conversation: String?, query: String, now: Date) -> HistoryPage {
        let since = now.addingTimeInterval(-Double(window) * 60)
        let words = query.lowercased()
        let kept = items.filter { item in
            guard let ts = item.ts, ts >= since, conversation == nil || item.conversationId == conversation else { return false }
            guard !words.isEmpty else { return true }
            return [item.title, item.command, item.reason, item.conversationTitle, item.project]
                .contains { $0?.lowercased().contains(words) == true }
        }
        var page = self
        page.window = window
        page.counts = Dictionary(grouping: kept, by: \.status).mapValues(\.count)
        page.items = kept.filter { status == nil || $0.status == status }
        return page
    }
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

/// Issue d'une demande, dans l'ordre des filtres, avec le vocabulaire de Vigie : `accepted` « Acceptée » (par Vigie
/// seule), `allowed` « Autorisée » (par toi) ; `blocked` (personne n'a répondu à temps, ou une règle) se lit « Refusée
/// d'office », jamais « Bloquée » ; `failed` « En échec ».
enum HistoryStatus: String, CaseIterable, Identifiable, Sendable {
    case accepted, allowed, refused, blocked, failed, question, vscode, waiting

    var id: String { rawValue }

    /// Le filtre : « Refusées d'office ».
    var title: String {
        switch self {
        case .accepted: "Acceptées"
        case .allowed: "Autorisées"
        case .refused: "Refusées"
        case .blocked: "Refusées d'office"
        case .failed: "En échec"
        case .question: "Questions"
        case .vscode: "Laissées à VS Code"
        case .waiting: "En attente"
        }
    }

    /// Une ligne : « Refusée d'office ».
    var label: String {
        switch self {
        case .accepted: "Acceptée"
        case .allowed: "Autorisée"
        case .refused: "Refusée"
        case .blocked: "Refusée d'office"
        case .failed: "En échec"
        case .question: "Question"
        case .vscode: "Laissée à VS Code"
        case .waiting: "En attente"
        }
    }

    var symbol: String {
        switch self {
        case .accepted: "checkmark.circle.fill"
        case .allowed: "hand.thumbsup.circle.fill"
        case .refused: "xmark.circle.fill"
        case .blocked: "hand.raised.fill"
        case .failed: "exclamationmark.triangle.fill"
        case .question: "questionmark.bubble.fill"
        case .vscode: "chevron.left.forwardslash.chevron.right"
        case .waiting: "hourglass"
        }
    }

    /// Le ton, d'après le sens des couleurs (`Theme`) : rouge pour ce qui n'est pas passé sans toi (refusée d'office,
    /// en échec) et pour ce qui t'attend encore ; le reste neutre (le vert veut dire « travaille », pas « réussi »).
    var tone: Chip.Tone {
        switch self {
        case .blocked, .failed, .waiting: .alert
        case .accepted, .allowed, .refused, .question, .vscode: .neutral
        }
    }

    /// Couleur de TEXTE de son libellé (lisible en mode clair).
    var color: Color {
        tone == .alert ? Theme.alertText : .secondary
    }
}
