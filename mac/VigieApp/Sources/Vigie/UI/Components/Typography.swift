import SwiftUI

// Standard de lecture de Vigie : 6 niveaux, les mêmes sur toutes les pages.
//
// | Niv. | Rôle              | Où                                                      | Style                                   | Composant            |
// |------|-------------------|---------------------------------------------------------|-----------------------------------------|----------------------|
// | 0    | Titre de page     | barre de la fenêtre                                     | `.navigationTitle` + `.navigationSubtitle` | natif             |
// | 1    | Titre d'objet     | verdict d'une conversation, en-tête du panneau de       | `.title3.bold()`, `.primary` (ou couleur | `ObjectHeader`      |
// |      |                   | droite, en-tête d'une feuille                           | de TEXTE du ton), sur plusieurs lignes  |                      |
// | 2    | Titre de section  | au-dessus d'une carte, HORS de la carte                 | `.headline`, `.primary`                 | `SectionHeader`      |
// | 3    | Surtitre          | DANS une carte, une tuile, un panneau ; groupe d'une    | `.subheadline.weight(.semibold)`,       | `CardTitle`          |
// |      |                   | liste (jour, groupe du plan) en variante compacte       | `.secondary` (rouge si alerte)          | (`compact: true`)    |
// | 4    | Titre d'élément   | rangée d'une liste                                      | `.body.weight(.semibold)` pour un objet | `.textRole(.item)`   |
// |      |                   |                                                         | qu'on ouvre, `.body` pour un événement  | `.textRole(.event)`  |
// | 5    | Ligne d'infos     | sous un titre d'élément, note de bas de section         | `.callout`, `.secondary`, « · »         | `InfoLine`           |
//
// Le code (commande, chemin) n'est pas un niveau de titre : `CodeLine` (`.caption.monospaced()`, coupé au milieu).
//
// Règles :
// - Titre de page (niv. 0) : le nom n'est jamais répété dans le corps de la page. Le sous-titre dit un état chiffré,
//   3 infos au plus, jamais une description (« 4 conversations ouvertes · 3 à décider »). Exception : la page d'une
//   conversation a pour sous-titre son identité (son titre de VS Code), précédé de sa place quand plusieurs
//   conversations attendent une décision et qu'elle en est (« 1re des 3 à décider · Refonte du site de la boutique »,
//   ⌘J passe à la suivante) ; son état est dans la tuile d'état.
// - Un seul titre d'objet (niv. 1) par vue ; les blocs suivants se titrent en `CardTitle`.
// - Panneau de la barre des menus : il est lui-même une seule carte, ses groupes se titrent en surtitre (`CardTitle`,
//   chiffre à droite), jamais en `SectionHeader`.
// - Compteurs : dans un titre de section, un chiffre gris juste après le titre (« Conversations 4 ») ; la pastille
//   rouge (`CountBadge(urgent: true)`) seulement pour des décisions qui t'attendent, et le même chiffre se lit aussi
//   sur la page (« 3 à décider »). Dans une carte : le chiffre à droite du surtitre (« 23/29 étapes »). Dans une
//   puce : « Journal 20 ». Dans un lien ou un bouton : « Tout afficher (24) ».
// - Vocabulaire des listes : « À décider » (il faut un clic maintenant : autoriser, refuser, répondre ; LE badge
//   rouge, `store.decisionItems`), « À regarder » (ce qui a mal tourné ou que tu dois faire toi-même : refus d'office,
//   échec, limite, sudo ; avec Voir et Retirer, `store.lookItems(for:)`), « À relire » (ce que Vigie a choisi pour
//   toi, `store.rereadItems(for:)`).
// - Lignes d'infos : qui · quoi · quand (conversation ou compte · règle ou type · heure), 3 infos au plus. « Qui » est
//   le `shortTitle` (« Atelier »). Le « · » ne sert qu'entre les infos, jamais dans un nom (« Portail/back »).
// - Un état qui demande un geste (« À autoriser », « refusée dans 8 min », « en échec ») n'entre pas dans la ligne :
//   il devient une `Chip` colorée à côté du titre.
// - Jamais d'identifiant technique (« faire:C7 », chemin complet, nom de workflow en tirets) dans un titre ou une
//   ligne : `Fmt.agentTitle`, `Fmt.workflowTitle`, et le nom brut en `.help`.
// - On coupe en fin de ligne, avec le texte entier en `.help`. On ne coupe jamais un bouton ni un état : la rangée
//   passe ses boutons à la ligne (`ViewThatFits`).
// - L'unité est toujours écrite (« 3 657 appels en 7 j », « 23/29 étapes ») : `Fmt.count(n, "appel")`.
// - Valeur inconnue : « — » (`Fmt.none`), un seul tiret dans toute l'app.
// - Dates : voir l'en-tête de Formatting.swift (un format par rôle).
//
// Espacements : 24 pt entre sections d'une page (déjà dans `Page`), 8 pt entre un `SectionHeader` et sa carte ; page
// d'une conversation : 12 pt entre tuiles, 20 pt avant un `SectionHeader` ; dans une carte : 12 pt de marge, 6 pt
// entre le `CardTitle` et le contenu ; panneau de droite : 14 pt entre blocs, 4 pt de plus au-dessus d'un surtitre.

/// Titre de section (niv. 2), au-dessus d'une carte et hors d'elle : titre en `.headline`, compteur juste après (gris,
/// ou pastille rouge si ce sont des décisions qui t'attendent), une note facultative dessous, une action à droite.
/// `CardSection(title, …)` le pose tout seul.
///
///     SectionHeader("Conversations", count: 4)
///     SectionHeader("À décider", count: 3, urgent: true)
///     SectionHeader("Apps ouvertes par un agent", note: "Tu peux les vouloir.") { Button("Tout arrêter") { … } }
///     SectionHeader("Au travail", inset: 0)   // au-dessus de tuiles sans retrait (page d'une conversation)
struct SectionHeader<Trailing: View>: View {
    let title: String
    var count: Int? = nil
    /// Pastille rouge : des décisions t'attendent. Sinon le compteur est un chiffre gris.
    var urgent = false
    /// Une phrase, sous le titre.
    var note: String? = nil
    /// Retrait horizontal, aligné sur le contenu de la carte (6). 0 au-dessus de tuiles qui n'ont pas de retrait.
    var inset: CGFloat = 6
    var trailing: Trailing

    init(_ title: String, count: Int? = nil, urgent: Bool = false, note: String? = nil, inset: CGFloat = 6,
         @ViewBuilder trailing: () -> Trailing) {
        self.title = title
        self.count = count
        self.urgent = urgent
        self.note = note
        self.inset = inset
        self.trailing = trailing()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(title)
                        .font(.headline)
                        .foregroundStyle(.primary)
                    if let count {
                        if urgent {
                            CountBadge(count: count, urgent: true)
                        } else {
                            Text(Fmt.int(count))
                                .font(.headline)
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        }
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                trailing
            }
            if let note, !note.isEmpty {
                Text(note)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, inset)
    }
}

extension SectionHeader where Trailing == EmptyView {
    init(_ title: String, count: Int? = nil, urgent: Bool = false, note: String? = nil, inset: CGFloat = 6) {
        self.init(title, count: count, urgent: urgent, note: note, inset: inset) { EmptyView() }
    }
}

/// Surtitre (niv. 3), DANS une carte, une tuile ou un panneau : le type de contenu en petit gris semi-gras, casse de
/// phrase (jamais de MAJUSCULES ni d'espacement élargi), une ligne ; le chiffre à droite (« 23/29 étapes »).
/// `compact` : un groupe dans une liste (jour, groupe du plan, groupes MCP du panneau) ou l'en-tête d'une bulle
/// (« Toi · hier 17:18 », avec `color: Theme.youText`).
///
///     CardTitle("Plan", trailing: "23/29 étapes")
///     CardTitle("Tests", trailing: "2 en échec", alert: true)
///     CardTitle("Hier", compact: true)
struct CardTitle: View {
    let title: String
    var trailing: String? = nil
    /// Rouge (couleur de texte `Theme.alertText`) : la tuile signale un problème.
    var alert = false
    var compact = false
    /// Autre couleur de TEXTE (`Theme.youText`…) ; prime sur `alert`.
    var color: Color? = nil

    init(_ title: String, trailing: String? = nil, alert: Bool = false, compact: Bool = false, color: Color? = nil) {
        self.title = title
        self.trailing = trailing
        self.alert = alert
        self.compact = compact
        self.color = color
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title)
                .font(compact ? .caption.weight(.semibold) : .subheadline.weight(.semibold))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 6)
            if let trailing, !trailing.isEmpty {
                Text(trailing)
                    .font(compact ? .caption : .callout)
                    .monospacedDigit()
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .foregroundStyle(tint)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    private var tint: AnyShapeStyle {
        if let color { return AnyShapeStyle(color) }
        return alert ? AnyShapeStyle(Theme.alertText) : AnyShapeStyle(.secondary)
    }
}

/// Ligne d'infos (niv. 5) sous un titre d'élément : `.callout`, `.secondary`, « · » entre les infos non vides, une
/// ligne coupée en fin, texte entier au survol. Ordre : qui · quoi · quand. 3 infos au plus (au-delà, une alerte en
/// mode debug : choisis les 3 qui comptent, le reste va dans le panneau ou en `.help`).
///
///     InfoLine(parts: [item.conversationTitle, item.rule, Fmt.when(item.ts, now: store.now)])
///     InfoLine("Atelier", "git push", "01:17")
struct InfoLine: View {
    let parts: [String?]
    /// Au survol, à la place de la ligne : le texte entier quand une info est raccourcie (une commande sans ses
    /// chemins).
    var fullText: String? = nil

    init(parts: [String?], help: String? = nil) {
        assert(parts.compactMap { $0?.isEmpty == false ? $0 : nil }.count <= 3,
               "InfoLine : 3 infos au plus (qui · quoi · quand) — \(parts)")
        self.parts = parts
        self.fullText = help
    }

    init(_ parts: String?...) {
        self.init(parts: parts)
    }

    /// Le texte joint (« Atelier · git push · 01:17 »), pour un `.help` ou un libellé VoiceOver.
    static func text(_ parts: [String?]) -> String {
        parts.compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
    }

    var body: some View {
        let text = Self.text(parts)
        Text(text)
            .font(.callout)
            .foregroundStyle(.secondary)
            .monospacedDigit()
            .lineLimit(1)
            .truncationMode(.tail)
            .help(fullText ?? text)
    }
}

/// Une commande ou un chemin, sous un titre : `.caption.monospaced()`, `.secondary`, coupé au milieu (on garde le
/// début et la fin), texte entier au survol. Pas un niveau de titre.
///
///     CodeLine(item.command ?? "")
///     CodeLine(Fmt.shortPath(folder))
struct CodeLine: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
            .help(text)
    }
}

/// Titre d'objet (niv. 1), un seul par vue : verdict d'une conversation, en-tête du panneau de droite, en-tête d'une
/// feuille. `.title3.bold()` sur plusieurs lignes au besoin, une ligne d'infos dessous, une icône à gauche (comme
/// celle des feuilles) et une couleur de TEXTE pour un verdict.
///
///     ObjectHeader("Attend ton accord", info: ["Atelier", "depuis 8 min"], icon: Icon.guardRule, color: Theme.alertText)
///     ObjectHeader(Fmt.agentTitle(name: agent.name, title: agent.title, id: agent.id, planSteps: steps),
///                  info: ["Agent", agent.phase, Fmt.when(agent.startedAt, now: store.now)])
struct ObjectHeader: View {
    let title: String
    var info: [String?] = []
    /// Une description sur plusieurs lignes, sous le titre (en-tête de feuille : une recette d'agent, la Bibliothèque),
    /// là où une ligne d'infos coupée ne convient pas.
    var note: String? = nil
    var icon: String? = nil
    /// Couleur de texte du titre (verdict) ; `.primary` sinon. L'icône prend la couleur de remplissage du même sens
    /// si on la donne (`iconColor`), sinon `.secondary`.
    var color: Color? = nil
    var iconColor: Color? = nil

    init(_ title: String, info: [String?] = [], note: String? = nil, icon: String? = nil, color: Color? = nil,
         iconColor: Color? = nil) {
        self.title = title
        self.info = info
        self.note = note
        self.icon = icon
        self.color = color
        self.iconColor = iconColor
    }

    var body: some View {
        // un titre seul se centre sur l'icône ; avec des lignes dessous, tout part du haut
        let alone = InfoLine.text(info).isEmpty && (note?.isEmpty ?? true)
        HStack(alignment: alone ? .center : .top, spacing: 12) {
            if let icon {
                Image(systemName: icon)
                    .symbolRenderingMode(.hierarchical)
                    .font(.system(size: 26))
                    .foregroundStyle(iconColor.map(AnyShapeStyle.init) ?? AnyShapeStyle(.secondary))
                    .frame(width: 34, height: 34)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.title3.bold())
                    .foregroundStyle(color.map(AnyShapeStyle.init) ?? AnyShapeStyle(.primary))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                if !InfoLine.text(info).isEmpty {
                    InfoLine(parts: info)
                }
                if let note, !note.isEmpty {
                    Text(note)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

/// Rôle d'un titre d'élément de liste (niv. 4).
enum TextRole: Sendable {
    /// Un objet qu'on ouvre (conversation, agent, MCP, compte, processus) : `.body.weight(.semibold)`.
    case item
    /// Un événement (journal, acceptation, garde-fou) : `.body`, en rouge seulement s'il t'attend.
    case event
}

extension View {
    /// Titre d'élément d'une rangée (niv. 4). `alert` : l'événement t'attend (couleur de texte `Theme.alertText`).
    /// Une ligne ; deux pour une action à décider (`.lineLimit(2)` posé par l'appelant).
    ///
    ///     Text(conversation.shortTitle).textRole(.item)
    ///     Text(item.title ?? "").textRole(.event, alert: item.needsDecision)
    /// Sans `alert`, la couleur reste celle de l'appelant (un MCP coupé peut passer en `.secondary`).
    @ViewBuilder
    func textRole(_ role: TextRole, alert: Bool = false) -> some View {
        let styled = font(role == .item ? .body.weight(.semibold) : .body)
        if alert {
            styled.foregroundStyle(Theme.alertText)
        } else {
            styled
        }
    }
}
