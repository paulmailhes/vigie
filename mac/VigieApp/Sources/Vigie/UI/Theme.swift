import SwiftUI

/// Couleurs, icônes et libellés partagés : une seule source pour toute l'app.
///
/// Une couleur = un sens, partout :
/// - vert (`live`) : travaille, consomme en ce moment ;
/// - orange (`warn`) : à surveiller, sans urgence (s'emballe, limite proche, MCP à connecter) ;
/// - rouge (`alert`) : t'attend ou bloqué, limite atteinte ;
/// - bleu (`action`) : ce sur quoi on clique (boutons principaux, liens) ;
/// - le reste en neutres ; atténué (`dim`) ce qui est fermé, pas connecté ou coupé.
/// Les icônes sont des SF Symbols monochromes, sans tuile colorée.
enum Theme {
    static let corner: CGFloat = 12

    static let live = Color.green
    static let warn = Color.orange
    static let alert = Color.red
    static let action = Color.blue
    /// Opacité de ce qui est fermé, pas connecté ou désactivé.
    static let dim: Double = 0.45

    /// Couleur de la pastille d'état.
    static func color(for status: ConversationStatus) -> Color {
        switch status {
        case .working: live
        case .waiting, .blocked: alert
        case .idle, .closed, .unknown: .secondary
        }
    }

    /// Ce qui demande l'utilisateur maintenant (seul cas où le rouge apparaît).
    static func needsYou(_ status: ConversationStatus) -> Bool {
        status == .waiting || status == .blocked
    }

    static func label(for status: ConversationStatus) -> String {
        switch status {
        case .working: "Travaille"
        case .idle: "Au repos"
        case .waiting: "T'attend"
        case .blocked: "Bloquée"
        case .closed: "Fermée"
        case .unknown: "Inconnu"
        }
    }

    /// Symbole utilisé quand la couleur seule ne suffit pas (accessibilité).
    static func symbol(for status: ConversationStatus) -> String {
        switch status {
        case .working: "bolt.circle.fill"
        case .idle: "moon.circle"
        case .waiting: "person.crop.circle.badge.exclamationmark"
        case .blocked: "hand.raised.circle.fill"
        case .closed, .unknown: "circle.dashed"
        }
    }

    /// Une icône par type d'élément validé.
    static func symbol(for kind: ItemKind) -> String {
        switch kind {
        case .command: Icon.command
        case .commit: Icon.commit
        case .push: Icon.push
        case .file: Icon.file
        case .web: Icon.web
        case .mcp: Icon.mcp
        case .agent: Icon.agent
        case .question: Icon.question
        case .other: Icon.other
        }
    }

    /// Libellé d'une décision ; rien pour « acceptée » (le cas normal), rouge pour ce qui t'attend.
    static func decision(_ decision: Decision) -> (label: String?, alert: Bool) {
        switch decision {
        case .auto: (nil, false)
        case .you: ("Par toi", false)
        case .blocked: ("Bloquée", true)
        case .waiting: ("T'attend", true)
        case .denied: ("Refusée", false)
        case .unknown: (nil, false)
        }
    }

    static func symbol(for kind: FileKind) -> String {
        switch kind {
        case .code: "chevron.left.forwardslash.chevron.right"
        case .style: "paintbrush"
        case .page: "doc.text.image"
        case .doc: "doc.text"
        case .data: "tablecells"
        case .image: "photo"
        case .media: "film"
        case .config: "gearshape"
        case .other: Icon.file
        }
    }

    static func title(for location: FileLocation) -> String {
        switch location {
        case .project: "Dans le projet"
        case .elsewhere: "Ailleurs sur ton Mac"
        case .scratch: "Brouillons"
        }
    }

    static func icon(for kind: TestKind) -> String {
        switch kind {
        case .tests: Icon.test
        case .e2e: "safari"
        case .types: "textformat"
        case .lint: "wand.and.stars"
        case .build: "hammer"
        case .other: "checklist"
        }
    }

    static func title(for kind: TestKind) -> String {
        switch kind {
        case .tests: "Tests"
        case .e2e: "Parcours"
        case .types: "Types"
        case .lint: "Relecture"
        case .build: "Construction"
        case .other: "Vérification"
        }
    }

    static func symbol(for kind: ReviewKind) -> String {
        switch kind {
        case .question: Icon.question
        case .blocked: Icon.guardRule
        case .waiting: Icon.waiting
        case .limit: Icon.limit
        case .other: "bell"
        }
    }

    /// Ce qui t'attend vraiment (rouge) : une action bloquée, une conversation en attente.
    static func isAlert(_ kind: ReviewKind) -> Bool {
        kind == .blocked || kind == .waiting
    }

    static func symbol(for kind: ReportKind) -> String {
        switch kind {
        case .artifact: Icon.artifact
        case .missionDone: Icon.mission
        case .workflowDone: Icon.workflow
        case .other: "bell"
        }
    }

    static func title(for group: MCPGroup) -> String {
        switch group {
        case .mac: "MCP de ce Mac"
        case .project: "MCP du projet"
        case .connector: "MCP du compte (claude.ai)"
        }
    }

    /// Couleur d'une jauge : neutre, orange à partir de 80 %, rouge à partir de 95 %.
    static func gaugeTint(_ pct: Double) -> Color {
        pct >= 95 ? alert : pct >= 80 ? warn : .secondary
    }
}
