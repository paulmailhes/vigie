import AppKit
import SwiftUI

/// Couleurs, icônes et libellés partagés : une seule source pour toute l'app.
///
/// Une couleur = un sens, partout :
/// - vert (`live`) : travaille, consomme en ce moment ;
/// - orange (`warn`) : à surveiller, sans urgence (s'emballe, limite proche, MCP à connecter) ;
/// - rouge (`alert`) : t'attend (à autoriser, à répondre), refusée d'office, en échec, limite atteinte ;
/// - bleu (`action`) : ce sur quoi on clique (boutons principaux, liens, filtre choisi). Jamais `Color.accentColor`,
///   qui suit la couleur d'accent du Mac (orange chez certains) et prendrait le sens d'un avertissement ;
/// - violet (`you`) : ce que tu as écrit, dans l'Échange d'une conversation ;
/// - le reste en neutres ; atténué (`dim`) ce qui est fermé, pas connecté ou coupé.
///
/// Deux familles par sens :
/// - REMPLISSAGE : `live`, `warn`, `alert`, `you` (couleurs système). Pour les ronds, icônes, jauges, courbes et fonds
///   teintés (`.opacity(0.12)`). Elles sont trop pâles pour du texte en mode clair (orange sur blanc : 2,3:1).
/// - TEXTE : `liveText`, `warnText`, `alertText`, `youText`. Pour tout mot écrit en couleur (verdict, « à connecter »,
///   « rien écrit depuis 10 min », titre d'une alerte). Mode clair : un ton plus foncé, au moins 4,5:1 sur fond blanc
///   et sur le gris d'une carte (et sur une puce teintée) ; contraste élevé : plus foncé encore ; mode sombre : la
///   couleur système pour le vert et l'orange, un ton plus clair pour le rouge et le violet (le rouge et le violet
///   système ne font que 3,5 à 3,9:1 sur une puce, une tuile ou une bulle teintée en sombre).
/// Le texte coloré reste réservé aux mots courts : une phrase longue s'écrit en `.primary` ou `.secondary`, avec
/// seulement son icône en couleur. Un texte qui informe ne descend jamais sous `.secondary` (`.tertiary` : les « · »
/// décoratifs et les chevrons seulement).
/// Les icônes sont des SF Symbols monochromes, sans tuile colorée.
enum Theme {
    /// Rayon des tuiles, sections et cartes posées sur la page (marge intérieure 12).
    static let corner: CGFloat = 12
    /// Rayon de ce qui est posé DANS une tuile (bulle de l'Échange, tuile d'agent, carte d'alerte) : plus petit que le
    /// rayon de la tuile, sinon les coins intérieurs paraissent trop ronds. Options d'une feuille : 8.
    static let cornerInner: CGFloat = 6

    // MARK: Remplissage (ronds, icônes, jauges, fonds teintés)

    static let live = Color.green
    static let warn = Color.orange
    static let alert = Color.red
    static let action = Color.blue
    /// Fond plein sous un texte blanc (filtre choisi) : le bleu système ne fait que 3,2 à 3,5:1 avec le blanc ; celui-ci
    /// 5,6:1, dans les deux modes. Les liens et boutons gardent `action`.
    static let actionFill = Color(red: 0, green: 0.4, blue: 0.8)
    /// Ce que tu as écrit (l'Échange d'une conversation) : réservé, jamais un état.
    static let you = Color.purple
    /// Opacité de ce qui est fermé, pas connecté ou désactivé.
    static let dim: Double = 0.45

    // MARK: Texte coloré (lisible en mode clair)

    /// Vert pour un mot : « en direct », « prêt ».
    static let liveText = textColor(light: 0x1A7230, highContrast: 0x145A26, dark: .systemGreen)
    /// Orange pour un mot : « rien écrit depuis 10 min », « à connecter », « S'emballe ».
    static let warnText = textColor(light: 0x9E4800, highContrast: 0x8A3F00, dark: .systemOrange)
    /// Rouge pour un mot : « À autoriser », « en échec », titre d'une alerte.
    static let alertText = textColor(light: 0xB8141A, highContrast: 0x9E1116, dark: rgb(0xFF7A73))
    /// Violet pour un mot : « Toi · hier 17:18 ».
    static let youText = textColor(light: 0x8E24AA, highContrast: 0x6F1C85, dark: rgb(0xE88AF7))

    /// Le chiffre écrit sur un fond `warnText` (compteur orange) : blanc en clair (6,2:1), noir à 85 % en sombre (sur
    /// l'orange système, le blanc ne fait que 2,3:1).
    static let onWarn = Color(nsColor: NSColor(name: "vigie.onWarn") { appearance in
        isDark(appearance) ? NSColor.black.withAlphaComponent(0.85) : .white
    })

    // MARK: Surfaces

    /// Surface « posée » sur une tuile (bulle de Claude, tuile d'agent, puce « À toi », puce sur une tuile teintée) :
    /// plus claire que la tuile dans les deux modes. `.background.opacity(0.7)` paraissait posé en clair mais creusé en
    /// sombre (presque noir sur une tuile grise).
    static let raised = Color(nsColor: NSColor(name: "vigie.raised") { appearance in
        isDark(appearance) ? NSColor.white.withAlphaComponent(0.06) : NSColor.white.withAlphaComponent(0.7)
    })

    /// Couleur de texte dynamique : un ton foncé fixe en clair (plus foncé encore en contraste élevé) ; en sombre, la
    /// couleur donnée (système, ou un ton clair fixe quand le système est trop sombre sur un fond teinté).
    private static func textColor(light: UInt32, highContrast: UInt32, dark: NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            switch appearance.bestMatch(from: [.aqua, .darkAqua, .accessibilityHighContrastAqua, .accessibilityHighContrastDarkAqua]) {
            case NSAppearance.Name.darkAqua, NSAppearance.Name.accessibilityHighContrastDarkAqua: dark
            case NSAppearance.Name.accessibilityHighContrastAqua: rgb(highContrast)
            default: rgb(light)
            }
        })
    }

    private static func isDark(_ appearance: NSAppearance) -> Bool {
        let match = appearance.bestMatch(from: [.aqua, .darkAqua, .accessibilityHighContrastAqua, .accessibilityHighContrastDarkAqua])
        return match == .darkAqua || match == .accessibilityHighContrastDarkAqua
    }

    private static func rgb(_ hex: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }

    /// Couleur de TEXTE d'un état (le rond garde `color(for:)`).
    static func textColor(for status: ConversationStatus) -> Color {
        switch status {
        case .working: liveText
        case .waiting, .blocked: alertText
        case .idle, .closed, .unknown: .secondary
        }
    }

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
        // une action sensible attend ta décision (« Bloquée » se lisait comme « déjà refusée »)
        case .blocked: "À autoriser"
        case .closed: "Fermée"
        case .unknown: "État inconnu"
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

    /// Libellé d'une décision du Journal ; rien pour « acceptée » (le cas normal), rouge pour ce qui t'attend ou a été
    /// refusé d'office. `blocked` = refusée par Vigie (délai, règle) : le moteur classe l'attente en `waiting`.
    static func decision(_ decision: Decision) -> (label: String?, alert: Bool) {
        switch decision {
        case .auto: (nil, false)
        case .you: ("Par toi", false)
        case .blocked: ("Refusée d'office", true)
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
        case .types: "Contrôle du code"
        case .lint: "Style du code"
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
        case .agentDone: Icon.agent
        case .other: "bell"
        }
    }

    static func title(for group: MCPGroup) -> String {
        switch group {
        case .mac: "MCP de ton Mac"
        case .project: "MCP du projet"
        case .connector: "MCP du compte (claude.ai)"
        }
    }

    /// Couleur d'une jauge : neutre, orange à partir de 80 %, rouge à partir de 95 %.
    static func gaugeTint(_ pct: Double) -> Color {
        pct >= 95 ? alert : pct >= 80 ? warn : .secondary
    }
}
