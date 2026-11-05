import AppKit
import Foundation

/// Outil « En fond » : ce que les conversations ont laissé tourner, relu toutes les 5 s quand la page est ouverte.
/// Arrêter retire la ligne tout de suite ; elle revient seulement si l'arrêt échoue.
extension VigieStore {
    /// Oubliés (conversation fermée) : le badge orange de la barre latérale.
    var forgottenCount: Int {
        if let background { return background.groups.filter { $0.groupState == .forgotten }.count }
        return backgroundSummary?.forgotten ?? 0
    }

    var stopForgotten: Bool {
        get { settings?.stopForgotten ?? true }
        set {
            patchSettings { $0.stopForgotten = newValue }
            Task { await sendSettings(["stopForgotten": .bool(newValue)]) }
        }
    }

    func followBackground() async {
        while !Task.isCancelled {
            guard windowVisible || isDemo else { return }
            await refreshBackground()
            if isDemo { return }
            try? await Task.sleep(for: .seconds(5))
        }
    }

    func refreshBackground() async {
        if isDemo, background != nil { return }
        let started = ContinuousClock.now
        do {
            var list = try await client.get("/api/v2/processes", as: BackgroundList.self, patient: true)
            guard isFresh(started) else { return }
            stoppedBackground = stoppedBackground.filter { Date.now.timeIntervalSince($0.value) < 20 }
            list.groups.removeAll { stoppedBackground[$0.id] != nil }
            if background != list { background = list }
            if backgroundProblem != nil { backgroundProblem = nil }
        } catch ClientError.refused(let text) {
            if !Task.isCancelled { backgroundProblem = text }
        } catch {
            // relevé lent ou moteur occupé : la page garde le relevé précédent
        }
    }

    /// Arrête ces groupes. Rend ceux qui attendent une confirmation (leur conversation travaille encore).
    @discardableResult
    func stopBackground(_ groups: [BackgroundGroup], confirm: Bool = false) async -> [BackgroundGroup] {
        let ids = Set(groups.map(\.id))
        let before = background
        for id in ids { stoppedBackground[id] = .now }
        background?.groups.removeAll { ids.contains($0.id) }
        guard !isDemo else { return [] }
        let body: JSONValue = .object(["ids": .array(groups.map { .string($0.id) }), "confirm": .bool(confirm)])
        guard let result = await write("/api/v2/processes/stop", body) else {
            for id in ids { stoppedBackground[id] = nil }
            background = before
            return []
        }
        // Ceux qui n'ont pas pu être arrêtés reviennent à l'écran.
        let failed = result.results.filter { $0.ok == false }
        guard !failed.isEmpty else { return [] }
        let back = Set(failed.map(\.id))
        for id in back { stoppedBackground[id] = nil }
        if let restored = before?.groups.filter({ back.contains($0.id) }) {
            background?.groups.append(contentsOf: restored)
        }
        let errors = failed.filter { $0.needsConfirm != true }.compactMap(\.error)
        if let first = errors.first { show(error: first) }
        return groups.filter { group in failed.contains { $0.id == group.id && $0.needsConfirm == true } }
    }

    /// Une app ouverte par un agent : quittée comme avec ⌘Q (elle peut demander d'enregistrer).
    func quitBackgroundApp(_ group: BackgroundGroup) {
        guard let bundle = group.bundle else { return }
        let apps = NSWorkspace.shared.runningApplications.filter { $0.bundleURL?.path.hasPrefix(bundle) == true }
        guard !apps.isEmpty else {
            show(error: "\(group.label ?? "Cette app") n'est plus ouverte")
            return
        }
        stoppedBackground[group.id] = .now
        background?.groups.removeAll { $0.id == group.id }
        for app in apps { app.terminate() }
    }
}
