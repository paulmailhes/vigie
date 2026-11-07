import Foundation

/// « À relire » : les fins de demande que tu as déjà vues (leur compte rendu affiché sous la conversation ouverte,
/// fenêtre à l'écran) ou retirées d'un clic. Une conversation fermée ensuite ne les remontre pas dans « À relire ».
///
/// Une règle pure, sans horloge (essais : ClosedEndsTests). Gardées 24 h, comme les fins que montre le moteur ; le
/// store les tient dans UserDefaults (jamais en démonstration).
struct SeenEnds: Equatable, Sendable {
    static let keptFor: TimeInterval = 24 * 3600

    /// Clé stable de la fin (`Report.stableKey`) → quand elle a été vue.
    private(set) var seen: [String: Date] = [:]

    func contains(_ key: String) -> Bool { seen[key] != nil }

    /// Note la fin comme vue, et oublie celles de plus de 24 h. Rend vrai si quelque chose a changé.
    @discardableResult
    mutating func insert(_ key: String, at date: Date) -> Bool {
        let before = seen
        seen = seen.filter { date.timeIntervalSince($0.value) < Self.keptFor }
        if seen[key] == nil { seen[key] = date }
        return seen != before
    }

    // MARK: Stockage

    private static let key = "overview.seenEnds"

    static func load(from defaults: UserDefaults = .standard, now: Date = .now) -> SeenEnds {
        let stored = (defaults.dictionary(forKey: key) as? [String: Double]) ?? [:]
        let seen = stored.mapValues { Date(timeIntervalSince1970: $0) }.filter { now.timeIntervalSince($0.value) < keptFor }
        return SeenEnds(seen: seen)
    }

    func save(to defaults: UserDefaults = .standard) {
        defaults.set(seen.mapValues(\.timeIntervalSince1970), forKey: Self.key)
    }
}
