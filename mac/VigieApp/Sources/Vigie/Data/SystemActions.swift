import AppKit

/// Gestes vers le reste du Mac : VS Code, Finder, presse-papiers, navigateur, relance du moteur.
@MainActor
enum SystemActions {
    static let vsCodeBundleID = "com.microsoft.VSCode"

    /// false : rien ne s'est ouvert (adresse illisible, aucune app pour elle).
    @discardableResult
    static func open(_ link: String?) -> Bool {
        guard let link, let url = URL(string: link) else { return false }
        return NSWorkspace.shared.open(url)
    }

    /// Ouvre un fichier (ou un dossier) dans VS Code : vscode://file<chemin encodé>. false : VS Code ne s'est pas ouvert.
    @discardableResult
    static func openInVSCode(path: String) -> Bool {
        let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? path
        guard let url = URL(string: "vscode://file" + (encoded.hasPrefix("/") ? encoded : "/" + encoded)) else { return false }
        return NSWorkspace.shared.open(url)
    }

    /// Une app du Mac ouvre les adresses vscode:// : VS Code est installé (VS Code Insiders seul ne compte pas).
    static var canOpenVSCode: Bool {
        guard let url = URL(string: "vscode://file/") else { return false }
        return NSWorkspace.shared.urlForApplication(toOpen: url) != nil
    }

    /// Met VS Code au premier plan (sans rien ouvrir de particulier).
    static func activateVSCode() {
        guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: vsCodeBundleID) else { return }
        NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration())
    }

    static func openTerminal() {
        guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Terminal") else { return }
        NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration())
    }

    static func revealInFinder(path: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(filePath: path)])
    }

    static func copy(_ text: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }

    /// Relance le service du moteur (launchd) : launchctl kickstart -k gui/<uid>/io.github.paulmailhes.vigie.engine.
    static func restartEngine(completion: @escaping @MainActor @Sendable (Bool) -> Void) {
        let process = Process()
        process.executableURL = URL(filePath: "/bin/launchctl")
        process.arguments = ["kickstart", "-k", "gui/\(getuid())/io.github.paulmailhes.vigie.engine"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { finished in
            let ok = finished.terminationStatus == 0
            Task { @MainActor in completion(ok) }
        }
        do {
            try process.run()
        } catch {
            completion(false)
        }
    }
}
