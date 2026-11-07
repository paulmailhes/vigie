import Foundation

// Dates : un format par rôle, partout (jamais `date.formatted(…)` en direct dans un écran).
//
// | Rôle                   | Exemple                                         | Fonction                                    |
// |------------------------|-------------------------------------------------|---------------------------------------------|
// | Événement passé        | « 01:17 », « hier 23:10 », « lun. 26 oct. 20:00 » | `Fmt.when(date, now: store.now)`. Jamais     |
// |                        |                                                 | `Fmt.time` seul, sauf dans une liste déjà   |
// |                        |                                                 | groupée par jour.                           |
// | En cours               | « depuis 8 h »                                  | `"depuis " + Fmt.age(since:now:)`           |
// | Fraîcheur d'un relevé  | « mis à jour il y a 12 min · 01:18 »            | vue `Freshness(date:)` ; hors d'une vue     |
// |                        |                                                 | `Freshness.text(date:now:)`. Un seul verbe  |
// |                        |                                                 | (« mis à jour », jamais « relevé »).        |
// | Échéance               | « dans 8 min », « remise à zéro lun. 26 oct. à  | `Fmt.remaining(until:now:)`,                |
// |                        | 20:00 »                                         | `Fmt.reset(date, now:)`                     |
// | Durée finie            | « a pris 1 h 05 »                               | `Fmt.duration(ms:)`                         |
// | Relatif (en direct)    | « il y a 4 min », « à l'instant »               | `Fmt.ago` : seulement pour ce qui est en    |
// |                        |                                                 | direct, pareil dans la tuile et son panneau |
//
// Une notification dit une heure fixe (« refusée à 01:26 »), pas un délai : son texte est figé.
// Nombres : toujours avec leur unité (`Fmt.count(3657, "appel")` → « 3 657 appels »), chiffres tabulaires
// (`.monospacedDigit()`), espace insécable avant % et les unités. Valeur inconnue : `Fmt.none` (« — »).

/// Formats en français, heure locale.
enum Fmt {
    static let locale = Locale(identifier: "fr_FR")

    /// « Pas de valeur » : un seul tiret dans toute l'app.
    static let none = "—"

    /// « 01:17 ». Pour un fait passé, `when` (sauf dans une liste déjà groupée par jour).
    static func time(_ date: Date) -> String {
        date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).locale(locale))
    }

    private static func day(_ date: Date) -> String {
        date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).locale(locale))
    }

    /// « 02:14 » aujourd'hui, « hier 18:39 », sinon « lun. 26 oct. 20:00 ».
    static func when(_ date: Date?, now: Date = .now) -> String {
        guard let date else { return "" }
        let calendar = Calendar.current
        if calendar.isDate(date, inSameDayAs: now) { return time(date) }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return "hier \(time(date))"
        }
        return "\(day(date)) \(time(date))"
    }

    /// Date et heure exactes de remise à zéro : « lun. 26 oct. à 20:00 », « aujourd'hui à 03:40 ».
    static func reset(_ date: Date, now: Date = .now) -> String {
        let calendar = Calendar.current
        if calendar.isDate(date, inSameDayAs: now) { return "aujourd'hui à \(time(date))" }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: tomorrow) {
            return "demain à \(time(date))"
        }
        return "\(day(date)) à \(time(date))"
    }

    /// Échéance proche : « dans 40 s », « dans 8 min », « dans 2 h », « dans 3 j » ; « maintenant » une fois passée.
    /// Pour une date lointaine et exacte (remise à zéro), `reset`.
    static func remaining(until date: Date?, now: Date = .now) -> String {
        guard let date else { return "" }
        let seconds = date.timeIntervalSince(now)
        guard seconds > 0 else { return "maintenant" }
        switch seconds {
        case ..<60: return "dans \(Int(seconds.rounded(.up))) s"
        case ..<3600: return "dans \(Int((seconds / 60).rounded(.up))) min"
        case ..<86_400: return "dans \(Int(seconds / 3600)) h"
        default: return "dans \(Int(seconds / 86_400)) j"
        }
    }

    /// « à l'instant », « il y a 12 min », « il y a 3 h », « il y a 2 j ».
    static func ago(_ date: Date?, now: Date = .now) -> String {
        guard let date else { return "" }
        let seconds = max(0, now.timeIntervalSince(date))
        switch seconds {
        case ..<60: return "à l'instant"
        case ..<3600: return "il y a \(Int(seconds / 60)) min"
        case ..<86_400: return "il y a \(Int(seconds / 3600)) h"
        default: return "il y a \(Int(seconds / 86_400)) j"
        }
    }

    /// « 21 s », « 42 min », « 1 h 05 », « 8 h ».
    static func duration(ms: Double?) -> String {
        guard let ms, ms > 0 else { return "" }
        let seconds = Int(ms / 1000)
        if seconds < 60 { return "\(seconds) s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes) min" }
        let hours = minutes / 60
        let rest = minutes % 60
        if hours >= 10 || rest == 0 { return "\(hours) h" }
        return "\(hours) h \(rest < 10 ? "0" : "")\(rest)"
    }

    static func int(_ value: Int?) -> String {
        (value ?? 0).formatted(.number.locale(locale))
    }

    static func pct(_ value: Double?) -> String {
        guard let value else { return none }
        let rounded = value >= 10 || value == value.rounded() ? value.rounded() : (value * 10).rounded() / 10
        return "\(rounded.formatted(.number.locale(locale)))\u{00A0}%"
    }

    /// « 182 k », « 1,2 M ».
    static func tokens(_ value: Int) -> String {
        if value >= 1_000_000 {
            return "\((Double(value) / 1_000_000).formatted(.number.precision(.fractionLength(0...1)).locale(locale))) M"
        }
        return "\(Int((Double(value) / 1000).rounded())) k"
    }

    /// « /Users/alex/Code/atelier » → « ~/Code/atelier ».
    static func shortPath(_ path: String) -> String {
        var home = FileManager.default.homeDirectoryForCurrentUser.path(percentEncoded: false)
        if home.hasSuffix("/") { home.removeLast() }
        guard !home.isEmpty, path == home || path.hasPrefix(home + "/") else { return path }
        return "~" + path.dropFirst(home.count)
    }

    /// Mémoire : « 15 Mo », « 2,1 Go », « 16 Go ».
    static func memory(mb: Double?) -> String {
        guard let mb, mb > 0 else { return none }
        if mb < 1000 { return "\(Int(mb.rounded())) Mo" }
        let gb = mb / 1024
        return gb < 10 ? gb.formatted(.number.precision(.fractionLength(1))) + " Go" : "\(Int(gb.rounded())) Go"
    }

    /// Âge court : « 40 s », « 9 min », « 2 h », « 3 j ».
    static func age(since date: Date?, now: Date = .now) -> String {
        guard let date else { return "" }
        let seconds = max(0, now.timeIntervalSince(date))
        switch seconds {
        case ..<60: return "\(Int(seconds)) s"
        case ..<3600: return "\(Int(seconds / 60)) min"
        case ..<86_400: return "\(Int(seconds / 3600)) h"
        default: return "\(Int(seconds / 86_400)) j"
        }
    }

    /// Un nombre avec son unité, accordée : « 0 appel », « 1 appel », « 3 657 appels », « 2 travaux » (pluriel
    /// irrégulier en troisième argument). Le français garde le singulier pour 0 et 1.
    static func count(_ value: Int, _ singular: String, _ plural: String? = nil) -> String {
        "\(int(value)) \(value > 1 ? (plural ?? singular + "s") : singular)"
    }

    // MARK: Noms lisibles (jamais d'identifiant technique à l'écran)

    /// Titre d'un agent d'une conversation : son nom lisible ; sinon sa description ; sinon, pour un identifiant
    /// technique (« faire:C7 »), le libellé de l'étape du plan qu'il fait (« C7 Poser les 37 doubles pages ») ou
    /// « Agent C7 » ; sinon « Agent ». L'identifiant brut va en `.help`.
    ///
    ///     Text(Fmt.agentTitle(name: agent.name, title: agent.title, id: agent.id, planSteps: detail.now?.plan?.steps ?? []))
    ///         .help(agent.title ?? agent.id)
    static func agentTitle(name: String?, title: String?, id: String?, planSteps: [PlanStep] = []) -> String {
        let candidates = [name, title].compactMap(trimmed)
        if let readable = candidates.first(where: { !isTechnical($0) && !isSlug($0) }) { return readable }
        for raw in candidates + [id].compactMap(trimmed) {
            guard let code = technicalCode(raw) else { continue }
            if let step = planSteps.first(where: { $0.id?.caseInsensitiveCompare(code) == .orderedSame }), !step.label.isEmpty {
                return step.label
            }
            return "Agent \(code)"
        }
        if let slug = candidates.first(where: isSlug) { return humanized(slug) }
        return "Agent"
    }

    /// Nom d'un workflow écrit en tirets (« partie-c-charte-ecrans ») : « Partie c charte ecrans ». Un nom déjà
    /// lisible reste tel quel. Le nom brut va en `.help`.
    ///
    ///     Text(Fmt.workflowTitle(workflow.name ?? workflow.id)).help(workflow.name ?? workflow.id)
    static func workflowTitle(_ raw: String) -> String {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return raw }
        if name.contains(where: \.isWhitespace) || !(name.contains("-") || name.contains("_")) { return name }
        return humanized(name)
    }

    private static func trimmed(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }

    /// « faire:C7 », « explore:L2.24 » : un préfixe et un code collés par « : », sans espace.
    private static func isTechnical(_ value: String) -> Bool {
        technicalCode(value) != nil
    }

    /// Le code après le dernier « : » d'un identifiant technique (« faire:C7 » → « C7 »).
    private static func technicalCode(_ value: String) -> String? {
        guard !value.contains(where: \.isWhitespace), let colon = value.lastIndex(of: ":") else { return nil }
        let head = value[..<colon]
        let code = value[value.index(after: colon)...]
        guard !head.isEmpty, !code.isEmpty else { return nil }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: ".-_"))
        guard code.unicodeScalars.allSatisfy(allowed.contains) else { return nil }
        return String(code)
    }

    /// « livre-lot-6 », « partie_c » : minuscules et chiffres collés par des tirets, sans espace.
    private static func isSlug(_ value: String) -> Bool {
        guard !value.contains(where: \.isWhitespace), value.contains("-") || value.contains("_") else { return false }
        return value.allSatisfy { ($0.isLetter && $0.isLowercase) || $0.isNumber || $0 == "-" || $0 == "_" }
    }

    /// Tirets en espaces, majuscule initiale, une lettre seule en capitale (le repère d'une partie du plan) :
    /// « partie-c-charte-ecrans » → « Partie C charte ecrans ».
    private static func humanized(_ value: String) -> String {
        let spaced = value.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
            .split(separator: " ", omittingEmptySubsequences: true)
            .map { $0.count == 1 && $0.first?.isLetter == true ? $0.uppercased() : String($0) }
            .joined(separator: " ")
        return spaced.prefix(1).uppercased() + spaced.dropFirst()
    }
}
