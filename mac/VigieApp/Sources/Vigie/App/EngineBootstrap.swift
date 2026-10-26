import AppKit
import ServiceManagement

/// L'app glissée dans Applications installe elle-même le moteur qu'elle contient (Contents/Resources/engine) :
/// au premier lancement, puis chaque fois que l'app est plus récente que le moteur installé (~/.vigie/VERSION).
/// Le moteur garde sa place habituelle (~/.vigie) : réglages, historique et comptes ne bougent pas.
/// Une app installée par Terminal (dans ~/.vigie/mac) n'a rien à faire ici : les mises à jour s'en chargent.
@MainActor
enum EngineBootstrap {
    enum Placement { case applications, terminalInstall, mountedOrTranslocated, elsewhere }

    static var home: URL { FileManager.default.homeDirectoryForCurrentUser.appending(path: ".vigie") }
    static var bundledEngine: URL? {
        guard let url = Bundle.main.resourceURL?.appending(path: "engine"),
              FileManager.default.isExecutableFile(atPath: url.appending(path: "scripts/bootstrap.sh").path) else { return nil }
        return url
    }

    static var placement: Placement {
        let path = Bundle.main.bundlePath
        if path.hasPrefix(home.path + "/") { return .terminalInstall }
        // ouverte depuis le DMG, ou depuis Téléchargements sans l'avoir déplacée (macOS la « déplace » ailleurs)
        if path.hasPrefix("/Volumes/") || path.contains("/AppTranslocation/") { return .mountedOrTranslocated }
        if path.hasPrefix("/Applications/") || path.hasPrefix(FileManager.default.homeDirectoryForCurrentUser.appending(path: "Applications").path + "/") {
            return .applications
        }
        return .elsewhere
    }

    private static func version(at url: URL) -> String? {
        (try? String(contentsOf: url.appending(path: "VERSION"), encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Le moteur livré est-il à installer (absent, ou plus ancien que celui de l'app) ?
    static var needed: Bool {
        guard placement != .terminalInstall, placement != .mountedOrTranslocated,
              let engine = bundledEngine, let bundled = version(at: engine) else { return false }
        guard let installed = version(at: home) else { return true }
        return VigieStore.isNewer(bundled, than: installed)
    }

    /// Lance scripts/bootstrap.sh du moteur livré (Node.js téléchargé s'il manque : jusqu'à une minute).
    /// nil : installé ; sinon les dernières lignes du journal (~/Library/Logs/Vigie-installation.log).
    static func install() async -> String? {
        guard let engine = bundledEngine else { return "Vigie est incomplet : télécharge-le à nouveau." }
        let log = FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/Logs/Vigie-installation.log")
        return await withCheckedContinuation { continuation in
            let process = Process()
            process.executableURL = URL(filePath: "/bin/bash")
            process.arguments = [engine.appending(path: "scripts/bootstrap.sh").path]
            var env = ProcessInfo.processInfo.environment
            env["VIGIE_APP"] = Bundle.main.bundlePath
            env["VIGIE_FROM_APP"] = "1"
            env["PATH"] = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            process.environment = env
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            process.terminationHandler = { finished in
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                try? data.write(to: log)
                let text = String(decoding: data, as: UTF8.self)
                let tail = text.split(separator: "\n").suffix(3).joined(separator: "\n")
                continuation.resume(returning: finished.terminationStatus == 0 ? nil : (tail.isEmpty ? "Installation interrompue." : tail))
            }
            do { try process.run() } catch { continuation.resume(returning: "Installation impossible : \(error.localizedDescription)") }
        }
    }

    /// Ouverture à la connexion : élément d'ouverture de macOS (Réglages Système › Général › Ouverture).
    static func registerLoginItem() {
        guard placement == .applications || placement == .elsewhere else { return }
        if SMAppService.mainApp.status != .enabled { try? SMAppService.mainApp.register() }
    }

    static func unregisterLoginItem() {
        if SMAppService.mainApp.status != .notRegistered { try? SMAppService.mainApp.unregister() }
    }

    /// Ouverte depuis le DMG ou Téléchargements : on demande de la glisser dans Applications, puis on quitte.
    static func askToMoveAndQuit() {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
        let alert = NSAlert()
        alert.messageText = "Glisse Vigie dans Applications"
        alert.informativeText = "Vigie s'installe depuis le dossier Applications. Dans la fenêtre du téléchargement, glisse l'icône de Vigie sur Applications, puis ouvre-la depuis Applications."
        alert.addButton(withTitle: "OK")
        alert.runModal()
        NSApp.terminate(nil)
    }
}
