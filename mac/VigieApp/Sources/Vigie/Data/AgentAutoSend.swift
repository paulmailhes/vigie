import AppKit
import ApplicationServices

/// Envoie tout seul le message d'un agent. L'extension Claude Code de VS Code et l'app Claude ne font que le
/// préremplir (un lien ne doit pas pouvoir faire travailler Claude) : Vigie appuie sur Entrée à ta place, seulement
/// dans le champ de Claude et seulement s'il contient ce message (le chemin du brief, qui n'est que là). Il faut
/// l'accès « Accessibilité » de macOS ; sans lui, rien ne change (le message attend que tu l'envoies).
///
/// VS Code, en plus :
/// - un dossier tout neuf : VS Code demande s'il fait confiance à ses auteurs, et l'extension ne démarre pas avant.
///   Vigie répond oui pour ce dossier-là seulement (celui que tu as choisi pour l'agent), pendant que le moteur attend
///   la fenêtre ;
/// - une conversation déjà ouverte : VS Code refuse le message (« Session is already open »). Vigie le colle dans le
///   champ de cette conversation, s'il est vide, puis l'envoie.
@MainActor
final class AgentAutoSend {
    enum Outcome: Equatable { case sent, notFound }

    static var allowed: Bool { AXIsProcessTrusted() }

    /// Demande l'accès (macOS ouvre Réglages › Confidentialité › Accessibilité).
    static func requestAccess() {
        // kAXTrustedCheckOptionPrompt vaut « AXTrustedCheckOptionPrompt »
        _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    }

    private let bundleIDs: [String]
    private let isVSCode: Bool
    private let folderName: String
    private let marker: String
    private var prompt: String?
    private var answeredAt: Date?
    private var trusted = false
    private var pasted = false

    /// `folder` : le dossier du projet ; `marker` : un morceau du message qui n'est que là (`.vigie/agent-<id>.md`).
    init(surface: AgentSurface, folder: String, marker: String) {
        isVSCode = surface == .vscode
        bundleIDs = isVSCode ? ["com.microsoft.VSCode", "com.microsoft.VSCodeInsiders"] : ["com.anthropic.claudefordesktop"]
        folderName = (folder as NSString).lastPathComponent
        self.marker = marker
    }

    /// La réponse du moteur : le message (pour le coller si la conversation était déjà ouverte).
    func answered(prompt: String?) {
        self.prompt = prompt
        answeredAt = .now
    }

    /// Guette le champ de Claude jusqu'à `timeout` (le moteur attend la fenêtre de VS Code jusqu'à 25 s).
    func run(timeout: Duration = .seconds(70)) async -> Outcome {
        let end = ContinuousClock.now + timeout
        var lastScan = ContinuousClock.now - .seconds(10)
        while ContinuousClock.now < end, !Task.isCancelled {
            if let app = NSWorkspace.shared.runningApplications.first(where: { bundleIDs.contains($0.bundleIdentifier ?? "") }) {
                let root = AXUIElementCreateApplication(app.processIdentifier)
                // Electron ne montre son contenu (webviews) aux outils d'accessibilité que sur demande
                AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
                // le plus rapide : le champ qui a le focus (l'extension le donne au champ prérempli)
                if let focused = element(root, kAXFocusedUIElementAttribute), isClaudeInput(focused), value(focused).contains(marker) {
                    if await send(focused, app: app, window: nil) { return .sent }
                }
                // sinon, toutes les deux secondes : la fenêtre du projet (VS Code) ou toutes (app Claude)
                if ContinuousClock.now - lastScan > .seconds(2) {
                    lastScan = .now
                    for window in windows(root) {
                        if isVSCode && !matchesProject(window) { continue }
                        if isVSCode && !trusted, let button = find(in: window, limit: 4000, skipWeb: true, where: isTrustButton) {
                            trusted = AXUIElementPerformAction(button, kAXPressAction as CFString) == .success
                            continue
                        }
                        let inputs = findAll(in: window, limit: 40000, where: isClaudeInput)
                        if let input = inputs.first(where: { value($0).contains(marker) }) {
                            if await send(input, app: app, window: window) { return .sent }
                        } else if isVSCode, !pasted, let prompt, let at = answeredAt, Date.now.timeIntervalSince(at) > 3 {
                            // conversation déjà ouverte : le message n'a pas été repris ; on le colle dans son champ vide
                            if let target = focusedInput(root, among: inputs) ?? (inputs.count == 1 ? inputs[0] : nil), isEmptyInput(value(target)) {
                                pasted = true
                                if await paste(prompt, into: target, app: app, window: window), await send(target, app: app, window: window) { return .sent }
                            }
                        }
                    }
                }
            }
            try? await Task.sleep(for: .milliseconds(400))
        }
        return .notFound
    }

    // MARK: Accessibilité

    private func element(_ e: AXUIElement, _ attribute: String) -> AXUIElement? {
        var v: AnyObject?
        guard AXUIElementCopyAttributeValue(e, attribute as CFString, &v) == .success, let v,
              CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    private func string(_ e: AXUIElement, _ attribute: String) -> String {
        var v: AnyObject?
        guard AXUIElementCopyAttributeValue(e, attribute as CFString, &v) == .success else { return "" }
        return (v as? String) ?? ""
    }

    private func value(_ e: AXUIElement) -> String { string(e, kAXValueAttribute) }

    private func children(_ e: AXUIElement) -> [AXUIElement] {
        var v: AnyObject?
        guard AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &v) == .success else { return [] }
        return (v as? [AXUIElement]) ?? []
    }

    private func windows(_ root: AXUIElement) -> [AXUIElement] {
        var v: AnyObject?
        guard AXUIElementCopyAttributeValue(root, kAXWindowsAttribute as CFString, &v) == .success else { return [] }
        return (v as? [AXUIElement]) ?? []
    }

    /// VS Code titre ses fenêtres « <onglet> — <dossier> » : celle du projet, et pas une autre.
    private func matchesProject(_ window: AXUIElement) -> Bool {
        let title = string(window, kAXTitleAttribute)
        return title == folderName || title.hasSuffix(" — \(folderName)") || title.contains(" — \(folderName) — ")
    }

    /// Le champ de saisie de Claude : une zone de texte décrite « Message input » (VS Code), ou, dans l'app Claude,
    /// toute zone de texte (on ne la touche que si elle contient le message).
    private func isClaudeInput(_ e: AXUIElement) -> Bool {
        let role = string(e, kAXRoleAttribute)
        guard role == kAXTextAreaRole || role == kAXTextFieldRole else { return false }
        return isVSCode ? string(e, kAXDescriptionAttribute) == "Message input" : true
    }

    /// Le bouton « Oui, je fais confiance aux auteurs » du dialogue de confiance de VS Code (anglais ou français).
    private func isTrustButton(_ e: AXUIElement) -> Bool {
        guard string(e, kAXRoleAttribute) == kAXButtonRole else { return false }
        let text = (string(e, kAXTitleAttribute) + " " + string(e, kAXDescriptionAttribute)).lowercased()
        return text.contains("trust the authors") || text.contains("confiance aux auteurs")
    }

    /// Vide, ou seulement son texte d'invite (« ⌘ Esc to focus or unfocus Claude », « Queue another message… ») :
    /// jamais un brouillon que tu aurais commencé.
    private func isEmptyInput(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty || (t.count < 70 && !t.contains("\n") && (t.contains("Claude") || t.hasSuffix("…")))
    }

    private func focusedInput(_ root: AXUIElement, among inputs: [AXUIElement]) -> AXUIElement? {
        guard let focused = element(root, kAXFocusedUIElementAttribute) else { return nil }
        if isClaudeInput(focused) { return focused }
        // le focus sur la conversation (un groupe) : son champ
        return find(in: focused, limit: 8000, skipWeb: false, where: isClaudeInput)
    }

    private func find(in e: AXUIElement, limit: Int, skipWeb: Bool, where match: (AXUIElement) -> Bool) -> AXUIElement? {
        var budget = limit
        return search(e, &budget, skipWeb: skipWeb, match: match, all: nil)
    }

    private func findAll(in e: AXUIElement, limit: Int, where match: (AXUIElement) -> Bool) -> [AXUIElement] {
        var budget = limit
        var out: [AXUIElement] = []
        _ = search(e, &budget, skipWeb: false, match: match, all: &out)
        return out
    }

    private func search(_ e: AXUIElement, _ budget: inout Int, skipWeb: Bool, match: (AXUIElement) -> Bool,
                        all: UnsafeMutablePointer<[AXUIElement]>?) -> AXUIElement? {
        budget -= 1
        if budget < 0 { return nil }
        if match(e) {
            if let all { all.pointee.append(e) } else { return e }
        }
        if skipWeb && string(e, kAXRoleAttribute) == "AXWebArea" { return nil }
        for child in children(e) {
            if let found = search(child, &budget, skipWeb: skipWeb, match: match, all: all) { return found }
            if budget < 0 { return nil }
        }
        return nil
    }

    // MARK: Clavier

    private func bringForward(_ input: AXUIElement, app: NSRunningApplication, window: AXUIElement?) async {
        if let window { AXUIElementPerformAction(window, kAXRaiseAction as CFString) }
        app.activate()
        AXUIElementSetAttributeValue(input, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        try? await Task.sleep(for: .milliseconds(250))
    }

    private func key(_ code: CGKeyCode, flags: CGEventFlags = [], to pid: pid_t) {
        let source = CGEventSource(stateID: .hidSystemState)
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { continue }
            event.flags = flags
            event.postToPid(pid)
        }
    }

    /// Le focus clavier de l'app est bien sur ce champ (sinon une touche irait ailleurs : un fichier ouvert…).
    private func hasFocus(_ input: AXUIElement, app: NSRunningApplication) -> Bool {
        guard let focused = element(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedUIElementAttribute) else { return false }
        return CFEqual(focused, input)
    }

    /// Entrée dans le champ, puis vérifie que le message est parti (le champ ne le contient plus).
    private func send(_ input: AXUIElement, app: NSRunningApplication, window: AXUIElement?) async -> Bool {
        for _ in 0..<2 {
            await bringForward(input, app: app, window: window)
            guard value(input).contains(marker), hasFocus(input, app: app), app.isActive else { continue }
            key(36, to: app.processIdentifier) // Entrée
            try? await Task.sleep(for: .milliseconds(900))
            if !value(input).contains(marker) { return true }
        }
        return false
    }

    /// Colle le message dans le champ (le presse-papiers est rendu ensuite) ; vrai s'il y est.
    private func paste(_ text: String, into input: AXUIElement, app: NSRunningApplication, window: AXUIElement?) async -> Bool {
        let board = NSPasteboard.general
        let saved = board.string(forType: .string)
        board.clearContents()
        board.setString(text, forType: .string)
        await bringForward(input, app: app, window: window)
        guard hasFocus(input, app: app), app.isActive else {
            board.clearContents()
            if let saved { board.setString(saved, forType: .string) }
            return false
        }
        key(9, flags: .maskCommand, to: app.processIdentifier) // ⌘V
        try? await Task.sleep(for: .milliseconds(600))
        let ok = value(input).contains(marker)
        board.clearContents()
        if let saved { board.setString(saved, forType: .string) }
        return ok
    }
}
