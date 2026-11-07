import Foundation

/// « Pendant ton absence » : au retour après plus de 2 h (fenêtre cachée ou écrans en veille), la bande « Depuis une
/// heure » résume l'absence, puis le redevient d'elle-même 30 min après le retour. Pas de bouton « J'ai vu ».
///
/// Une règle pure, sans horloge ni stockage (essais : AbsenceTests). Le store la tient à jour avec la visibilité de la
/// fenêtre (WindowVisibility) et la garde dans UserDefaults : une absence commencée app fermée compte aussi.
struct Absence: Equatable, Sendable {
    /// Une absence compte au-delà de 2 h.
    static let minimum: TimeInterval = 2 * 3600
    /// La bande la résume pendant 30 min après le retour.
    static let shownFor: TimeInterval = 30 * 60
    /// Le moteur ne résume pas plus loin que 24 h (les rapports remontent à 24 h).
    static let longest: TimeInterval = 24 * 3600

    /// Début de l'absence en cours ; nil : tu es là.
    var leftAt: Date?
    /// La dernière absence de plus de 2 h : son début et ton retour.
    var from: Date?
    var returnedAt: Date?

    /// La fenêtre quitte l'écran (ou les écrans s'endorment) : le début de l'absence, s'il n'est pas déjà noté.
    mutating func leave(at date: Date) {
        if leftAt == nil { leftAt = date }
    }

    /// La fenêtre revient. Au-delà de 2 h, l'absence devient la période à résumer ; en deçà, elle est oubliée et la
    /// précédente garde ce qui lui reste de ses 30 min.
    mutating func back(at date: Date) {
        guard let start = leftAt else { return }
        leftAt = nil
        guard date.timeIntervalSince(start) > Self.minimum else { return }
        from = start
        returnedAt = date
    }

    /// Le début de la période à demander au moteur (`GET /api/v2/overview?since=`), 24 h au plus ; nil : la dernière
    /// heure, comme d'habitude.
    func since(now: Date) -> Date? {
        guard let from, let returnedAt else { return nil }
        let elapsed = now.timeIntervalSince(returnedAt)
        guard elapsed >= 0, elapsed < Self.shownFor else { return nil }
        return max(from, now.addingTimeInterval(-Self.longest))
    }

    // MARK: Stockage

    private static let keys = (leftAt: "absence.leftAt", from: "absence.from", returnedAt: "absence.returnedAt")

    static func load(from defaults: UserDefaults = .standard) -> Absence {
        Absence(leftAt: defaults.object(forKey: keys.leftAt) as? Date,
                from: defaults.object(forKey: keys.from) as? Date,
                returnedAt: defaults.object(forKey: keys.returnedAt) as? Date)
    }

    func save(to defaults: UserDefaults = .standard) {
        for (key, value) in [(Self.keys.leftAt, leftAt), (Self.keys.from, from), (Self.keys.returnedAt, returnedAt)] {
            if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
        }
    }
}
