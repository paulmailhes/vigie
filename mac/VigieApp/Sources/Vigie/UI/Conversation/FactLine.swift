import SwiftUI

/// Une ligne de faits courts séparés par « · » (« 4 commits · 38 fichiers · modifié après les tests ») : gris, sauf le
/// mot qui signale quelque chose, dans sa couleur de TEXTE. Un seul `Text` : la ligne passe à la ligne au lieu de
/// dépasser de la tuile.
struct FactLine: Equatable {
    struct Fact: Equatable {
        enum Tone: Equatable {
            /// Gris, comme le reste de la ligne.
            case plain
            /// Gris avec une coche : vérifié. Jamais vert (le vert veut dire « travaille »).
            case checked
            /// Orange : à surveiller (modifié après les tests, pas commité, pas envoyé).
            case warn
            /// Rouge : en échec.
            case alert
        }

        var text: String
        var tone: Tone = .plain
        /// Gardé quand la ligne est trop longue : on retire d'abord les autres, en partant de la fin.
        var kept = false

        init(_ text: String, tone: Tone = .plain, kept: Bool = false) {
            self.text = text
            self.tone = tone
            self.kept = kept
        }
    }

    var facts: [Fact]

    var isEmpty: Bool { facts.isEmpty }

    /// `count` faits au plus : les faits non gardés partent d'abord, en partant de la fin.
    func limited(to count: Int) -> FactLine {
        var list = facts
        while list.count > count, let index = list.lastIndex(where: { !$0.kept }) {
            list.remove(at: index)
        }
        return FactLine(facts: Array(list.prefix(count)))
    }

    /// La ligne, la première lettre en majuscule. La couleur de base (gris) vient de l'appelant.
    var text: Text {
        var line: Text?
        for (offset, fact) in facts.enumerated() {
            let piece = Self.piece(fact, first: offset == 0)
            line = line.map { Text("\($0) · \(piece)") } ?? piece
        }
        return line ?? Text(verbatim: "")
    }

    /// Le texte seul, pour VoiceOver et le survol.
    var plain: String {
        ConversationVerdict.sentence(facts.map(\.text).joined(separator: " · "))
    }

    private static func piece(_ fact: Fact, first: Bool) -> Text {
        let words = first ? ConversationVerdict.sentence(fact.text) : fact.text
        switch fact.tone {
        case .plain: return Text(verbatim: words)
        case .checked: return Text("\(Image(systemName: "checkmark")) \(words)")
        case .warn: return Text(verbatim: words).foregroundStyle(Theme.warnText)
        case .alert: return Text(verbatim: words).foregroundStyle(Theme.alertText)
        }
    }
}

// MARK: Fini, mais pas vérifié

extension RequestChecks {
    /// Le verdict sur les tests, avec le libellé du moteur (sinon le nôtre) : tests réussis après la dernière
    /// modification (coche grise), modifié après les tests (orange), tests en échec (rouge), aucun test lancé (gris).
    var verdictFact: FactLine.Fact? {
        let text = label?.trimmingCharacters(in: .whitespacesAndNewlines)
        switch verdictKind {
        case .verified: return .init(text.nonEmpty ?? "tests réussis après la dernière modification", tone: .checked, kept: true)
        case .changedAfterTests: return .init(text.nonEmpty ?? "modifié après les tests", tone: .warn, kept: true)
        case .testsFailed: return .init(text.nonEmpty ?? "tests en échec", tone: .alert, kept: true)
        case .noTests: return .init(text.nonEmpty ?? "aucun test lancé", kept: true)
        // verdict d'une version plus récente du moteur : sa phrase, sans couleur
        case .unknown: return text.nonEmpty.map { .init($0, kept: true) }
        }
    }

    /// Ce qui n'est pas enregistré ou pas envoyé, en orange : les phrases du moteur, sinon les nôtres d'après les
    /// compteurs.
    var noteFacts: [FactLine.Fact] {
        var texts = notes.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        if texts.isEmpty {
            if let count = uncommitted, count > 0 {
                texts.append("\(Fmt.count(count, "fichier modifié", "fichiers modifiés")) après le dernier commit")
            }
            if let count = unpushed, count > 0 {
                texts.append(Fmt.count(count, "commit pas envoyé", "commits pas envoyés"))
            }
        }
        return texts.map { .init($0, tone: .warn, kept: true) }
    }

    var facts: [FactLine.Fact] {
        (verdictFact.map { [$0] } ?? []) + noteFacts
    }

    /// Au survol : sur quoi le verdict s'appuie (Vigie ne lit pas le code).
    func help(now: Date) -> String {
        var parts = ["D'après le Journal : les tests lancés (pas la construction ni les contrôles du code) et les fichiers de code du projet."]
        let times = [lastTestAt.map { "dernier test \(Fmt.when($0, now: now))" },
                     lastCodeAt.map { "dernière modification \(Fmt.when($0, now: now))" }].compactMap { $0 }
        if !times.isEmpty { parts.append(ConversationVerdict.sentence(times.joined(separator: ", ")) + ".") }
        if verdictKind == .verified { parts.append("Des tests réussis ne prouvent pas que tout est juste.") }
        return parts.joined(separator: " ")
    }
}

private extension Optional where Wrapped == String {
    /// La chaîne si elle n'est pas vide.
    var nonEmpty: String? {
        guard let value = self, !value.isEmpty else { return nil }
        return value
    }
}
