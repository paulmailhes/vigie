import Foundation

/// « À régler » (page MCP) : les lignes que tu as masquées d'une croix, parce que ce MCP ne t'intéresse pas là. Elles
/// sont retenues sur l'identité de la chose à régler (`MCPFix.id` : sorte, nom, dossier, comptes, état de la
/// passerelle). Si l'état change (en échec au lieu de « à connecter », un compte de plus à approuver, une passerelle
/// coupée par le service après « pas encore connecté »), c'est une autre ligne : elle revient.
/// La puce d'état reste sur la rangée du MCP, plus bas : elle dit l'état réel.
///
/// Une règle pure, sans horloge (essais : HiddenFixesTests). Le store la tient dans UserDefaults (jamais en
/// démonstration). Un masquage qui ne correspond plus à rien est oublié au bout de 24 h : un état passager (moteur
/// relancé, comptes pas encore lus) ne l'efface pas, et la liste ne grossit pas sans fin.
struct HiddenFixes: Codable, Equatable, Sendable {
    static let forgottenAfter: TimeInterval = 24 * 3600

    /// Les identités masquées (`MCPFix.id`).
    private(set) var ids: Set<String> = []
    /// Depuis quand une identité masquée ne correspond plus à rien à régler.
    private(set) var missingSince: [String: Date] = [:]

    func contains(_ id: String) -> Bool { ids.contains(id) }

    /// Ce qui reste à l'écran, dans le même ordre.
    func visible(_ fixes: [MCPFix]) -> [MCPFix] {
        fixes.filter { !ids.contains($0.id) }
    }

    /// Combien de ces lignes sont masquées.
    func hiddenCount(in fixes: [MCPFix]) -> Int {
        fixes.count { ids.contains($0.id) }
    }

    /// Masque une ligne. Rend vrai si quelque chose a changé.
    @discardableResult
    mutating func hide(_ id: String) -> Bool {
        missingSince[id] = nil
        return ids.insert(id).inserted
    }

    /// « Réafficher » : tout revient. Rend vrai si quelque chose a changé.
    @discardableResult
    mutating func showAll() -> Bool {
        guard !ids.isEmpty || !missingSince.isEmpty else { return false }
        self = HiddenFixes()
        return true
    }

    /// Oublie les masquages qui ne correspondent plus à rien depuis 24 h. `current` : les identités de tout ce qui est
    /// à régler maintenant, masqué ou non. Rend vrai si quelque chose a changé.
    @discardableResult
    mutating func prune(current: Set<String>, at date: Date) -> Bool {
        let before = self
        for id in ids {
            if current.contains(id) {
                missingSince[id] = nil
            } else if let since = missingSince[id] {
                if date.timeIntervalSince(since) >= Self.forgottenAfter {
                    ids.remove(id)
                    missingSince[id] = nil
                }
            } else {
                missingSince[id] = date
            }
        }
        return self != before
    }

    // MARK: Stockage

    private static let key = "mcp.hiddenFixes"

    static func load(from defaults: UserDefaults = .standard) -> HiddenFixes {
        guard let data = defaults.data(forKey: key),
              let value = try? JSONDecoder().decode(HiddenFixes.self, from: data) else { return HiddenFixes() }
        return value
    }

    func save(to defaults: UserDefaults = .standard) {
        guard !ids.isEmpty, let data = try? JSONEncoder().encode(self) else {
            defaults.removeObject(forKey: Self.key)
            return
        }
        defaults.set(data, forKey: Self.key)
    }
}

/// La croix « Masquer » de « À régler » et « Réafficher » : appliqués tout de suite à l'écran, gardés hors
/// démonstration.
extension VigieStore {
    func hideFix(_ fix: MCPFix) {
        changeHiddenFixes { $0.hide(fix.id) }
    }

    func showHiddenFixes() {
        changeHiddenFixes { $0.showAll() }
    }

    /// Oublie les masquages qui ne correspondent plus à rien (voir `HiddenFixes.prune`). La page MCP l'appelle avec
    /// tout ce qui est à régler, une fois les MCP et les comptes lus.
    func pruneHiddenFixes(current: Set<String>) {
        changeHiddenFixes { $0.prune(current: current, at: .now) }
    }

    private func changeHiddenFixes(_ change: (inout HiddenFixes) -> Bool) {
        var next = hiddenFixes
        guard change(&next) else { return }
        hiddenFixes = next
        if !isDemo { next.save() }
    }
}
