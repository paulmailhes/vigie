import AppKit
import SwiftUI

/// Mode --snapshot <dossier> (avec VIGIE_FIXTURES) : affiche chaque écran en clair puis en sombre,
/// dans une fenêtre 1280×820, et enregistre le rendu de SA PROPRE fenêtre en PNG (cacheDisplay,
/// aucune autorisation d'enregistrement d'écran), puis quitte.
@MainActor
final class SnapshotRunner {
    private let store: VigieStore
    private let folder: URL
    private var written: [String] = []

    init(store: VigieStore, folder: URL) {
        self.store = store
        self.folder = folder
    }

    func start() {
        Task { await run() }
    }

    private func run() async {
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            finish(code: 3, message: "Impossible de créer \(folder.path)")
            return
        }
        guard await waitUntil(seconds: 15, { self.store.loadedOnce && self.mainWindow != nil }),
              let window = mainWindow else {
            finish(code: 4, message: "Fenêtre ou données absentes (VIGIE_FIXTURES ?)")
            return
        }
        activateForCapture()
        window.makeKeyAndOrderFront(nil)
        place(window)
        _ = await waitUntil(seconds: 4) { NSApplication.shared.isActive && window.isKeyWindow }
        await settle(0.8)
        if let frameView = window.contentView?.superview, let rect = sidebarRect(window, frameView) {
            _ = renderSidebar(size: rect.size, behind: window)
        }

        let conversationID = store.conversations.first(where: \.isOpen)?.id
        let secondID = store.conversations.first { $0.project == "boutique" && $0.id != conversationID }?.id
        let question = store.toReview.first { $0.reviewKind == .question }

        for (theme, appearanceName) in [("clair", NSAppearance.Name.aqua), ("sombre", NSAppearance.Name.darkAqua)] {
            NSApplication.shared.appearance = NSAppearance(named: appearanceName)
            store.changeRequest = nil
            store.route = .overview
            await settle(1.0)
            await capture(window, "01-vue-ensemble-\(theme)")

            // Haut de la page d'une conversation (en-tête, où ça en est, plan), puis chaque onglet.
            for (number, id, name) in [(2, conversationID, "atelier"), (3, secondID, "boutique")] {
                guard let id else { continue }
                store.conversationTab = .fil
                store.focusTabs = false
                store.route = .conversation(id)
                _ = await waitUntil(seconds: 5) { self.store.details[id] != nil }
                await settle(1.0)
                await capture(window, "0\(number)-conversation-\(name)-\(theme)")
            }
            if let conversationID {
                store.route = .conversation(conversationID)
                _ = await waitUntil(seconds: 5) { self.store.details[conversationID] != nil }
                for (offset, tab) in ConversationTab.allCases.enumerated() {
                    store.conversationTab = tab
                    store.focusTabs = true
                    await settle(0.9)
                    await capture(window, String(format: "%02d", offset + 4) + "-onglet-\(tab.slug)-\(theme)")
                }
                store.conversationTab = .fil
            }

            store.showAccounts(nil)
            _ = await waitUntil(seconds: 5) { self.store.accountsState != nil }
            await settle(0.9)
            await capture(window, "10-comptes-\(theme)")

            store.route = .mcp
            _ = await waitUntil(seconds: 5) { self.store.mcp != nil }
            await settle(0.9)
            await capture(window, "11-mcp-\(theme)")

            store.route = .agents
            _ = await waitUntil(seconds: 5) { self.store.agentsState != nil }
            await settle(0.9)
            await capture(window, "16-agents-\(theme)")

            if let question {
                store.route = .overview
                await settle(0.5)
                store.changeRequest = question
                _ = await waitUntil(seconds: 4) { window.attachedSheet != nil }
                await settle(1.0)
                await capture(window, "12-feuille-changer-\(theme)")
                store.changeRequest = nil
                _ = await waitUntil(seconds: 4) { window.attachedSheet == nil }
                await settle(0.5)
            }

            await captureMenuPanel(theme: theme, appearance: NSAppearance(named: appearanceName))
            await captureAlone(OnboardingView(start: .welcome), "14-accueil-bienvenue-\(theme)", appearance: NSAppearance(named: appearanceName))
            await captureAlone(OnboardingView(start: .tools), "14-accueil-outils-\(theme)", appearance: NSAppearance(named: appearanceName))
            await captureAlone(OnboardingView(start: .guards), "14-accueil-actions-sensibles-\(theme)", appearance: NSAppearance(named: appearanceName))
            await captureAlone(OnboardingView(start: .accounts), "14-accueil-comptes-\(theme)", appearance: NSAppearance(named: appearanceName))
            await captureAlone(OnboardingView(start: .mcps), "14-accueil-mcp-\(theme)", appearance: NSAppearance(named: appearanceName))
            await captureAlone(OnboardingView(start: .ready), "14-accueil-pret-\(theme)", appearance: NSAppearance(named: appearanceName))
            await captureAlone(MCPLibrarySheet(), "15-bibliotheque-mcp-\(theme)", appearance: NSAppearance(named: appearanceName))
            if let agent = store.agentsState?.agents.first(where: \.canLaunch) {
                // un dossier où une conversation existe déjà (agents-folder.json), et deux fichiers joints
                let sheet = AgentLaunchSheet(agent: agent, folder: "~/Code/cabinet-martin", files: [
                    AgentAttachment(path: "/Users/alex/Downloads/questionnaire-cabinet-martin.pdf", size: 248_000, isFolder: false, isCopy: false),
                    AgentAttachment(path: "/Users/alex/Downloads/charte-graphique.pdf", size: 3_400_000, isFolder: false, isCopy: false),
                ])
                await captureAlone(sheet, "17-feuille-agent-\(theme)", appearance: NSAppearance(named: appearanceName))
            }
        }

        finish(code: 0, message: "\(written.count) captures dans \(folder.path)")
    }

    // MARK: Fenêtre

    private var mainWindow: NSWindow? {
        let candidates = NSApplication.shared.windows.filter { $0.isVisible && $0.canBecomeMain && $0.sheetParent == nil }
        return candidates.first { $0.identifier?.rawValue.contains(VigieApp.mainWindowID) == true } ?? candidates.first
    }

    private func place(_ window: NSWindow) {
        let size = NSSize(width: 1280, height: 820)
        let visible = window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let origin = NSPoint(x: visible.minX + max(0, (visible.width - size.width) / 2),
                             y: visible.minY + max(0, (visible.height - size.height) / 2))
        window.setFrame(NSRect(origin: origin, size: size), display: true)
    }

    // MARK: Capture

    /// Ce qu'on pose, dans l'ordre, sur l'image finale.
    private enum Piece {
        /// Rendu d'une vue, à sa place.
        case image(NSBitmapImageRep, NSRect)
        /// Zone en verre (que cacheDisplay ne dessine pas) : teinte approchante.
        case glass(NSRect)
        /// Feuille par-dessus la fenêtre : voile, ombre, puis rendu.
        case sheet(NSBitmapImageRep, NSRect)
        /// Fond de barre d'outils (le flou des bords de défilement n'est pas capturé).
        case veil(NSRect)
    }

    private func capture(_ window: NSWindow, _ name: String) async {
        // Fenêtre active pour un rendu fidèle (interrupteurs en couleur, sélection) ; si une autre app
        // a repris la main entre deux captures, on la récupère.
        if !(NSApplication.shared.isActive && (window.isKeyWindow || window.attachedSheet != nil)) {
            activateForCapture()
            if window.attachedSheet == nil { window.makeKeyAndOrderFront(nil) }
            _ = await waitUntil(seconds: 2) { NSApplication.shared.isActive }
            await settle(0.4)
        }
        guard let frameView = window.contentView?.superview ?? window.contentView else { return }
        frameView.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        guard let base = render(frameView) else { return }
        let scale = CGFloat(base.pixelsWide) / max(frameView.bounds.width, 1)
        var pieces: [Piece] = [.image(base, frameView.bounds)]

        // La barre latérale vit dans un NSGlassEffectView que cacheDisplay ne dessine pas :
        // on pose à sa place le rendu de la même SidebarView, faite dans une fenêtre d'appoint.
        if let below = sidebarRect(window, frameView) {
            pieces.append(.glass(below.insetBy(dx: 8, dy: 8)))
            if let sidebar = renderSidebar(size: below.size, behind: window) {
                pieces.append(.image(sidebar, below))
            }
        }

        // Barre de titre et d'outils redessinée sur un fond opaque, comme le flou du système.
        if let titlebar = frameView.subviews.first(where: { String(describing: type(of: $0)) == "NSTitlebarContainerView" }),
           let image = render(titlebar) {
            let rect = place(titlebar, in: frameView)
            pieces.append(.veil(rect))
            pieces.append(.image(image, rect))
        }

        if let sheet = window.attachedSheet, let sheetView = sheet.contentView?.superview ?? sheet.contentView {
            sheetView.layoutSubtreeIfNeeded()
            sheet.displayIfNeeded()
            if let sheetImage = render(sheetView) {
                let rect = NSRect(x: sheet.frame.minX - window.frame.minX,
                                  y: sheet.frame.minY - window.frame.minY,
                                  width: sheet.frame.width, height: sheet.frame.height)
                pieces.append(.sheet(sheetImage, rect))
            }
        }
        guard let output = flatten(pieces, size: frameView.bounds.size, scale: scale, appearance: window.effectiveAppearance) else { return }
        save(output, name)
    }

    private func glassViews(in view: NSView) -> [NSGlassEffectView] {
        var found: [NSGlassEffectView] = []
        for sub in view.subviews where !sub.isHidden {
            if let glass = sub as? NSGlassEffectView {
                found.append(glass)
            } else {
                found.append(contentsOf: glassViews(in: sub))
            }
        }
        return found
    }

    /// Rectangle d'une vue dans le repère (non retourné) de l'image finale.
    private func place(_ view: NSView, in root: NSView) -> NSRect {
        var rect = view.convert(view.bounds, to: root)
        if root.isFlipped { rect.origin.y = root.bounds.height - rect.maxY }
        return rect
    }

    private func render(_ view: NSView) -> NSBitmapImageRep? {
        guard view.bounds.width > 0, view.bounds.height > 0,
              let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return nil }
        view.cacheDisplay(in: view.bounds, to: rep)
        return rep
    }

    /// Pose les morceaux sur le fond de fenêtre (image opaque).
    private func flatten(_ pieces: [Piece], size: NSSize, scale: CGFloat, appearance: NSAppearance) -> NSBitmapImageRep? {
        let width = Int((size.width * scale).rounded())
        let height = Int((size.height * scale).rounded())
        guard let output = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
                                            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        // La taille en points doit être fixée AVANT de créer le contexte (sinon tout est dessiné à 1×).
        output.size = size
        guard let context = NSGraphicsContext(bitmapImageRep: output) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        appearance.performAsCurrentDrawingAppearance {
            NSColor.windowBackgroundColor.setFill()
            NSRect(origin: .zero, size: size).fill()
            for piece in pieces {
                switch piece {
                case .image(let rep, let rect):
                    rep.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
                case .glass(let rect):
                    let shape = NSBezierPath(roundedRect: rect, xRadius: 18, yRadius: 18)
                    NSColor.quaternarySystemFill.setFill()
                    shape.fill()
                    NSColor.separatorColor.withAlphaComponent(0.5).setStroke()
                    shape.lineWidth = 1
                    shape.stroke()
                case .veil(let rect):
                    NSColor.windowBackgroundColor.withAlphaComponent(0.94).setFill()
                    rect.fill(using: .sourceOver)
                    NSColor.separatorColor.setFill()
                    NSRect(x: rect.minX, y: rect.minY, width: rect.width, height: 1).fill(using: .sourceOver)
                case .sheet(let rep, let rect):
                    NSColor.black.withAlphaComponent(0.18).setFill()
                    NSRect(origin: .zero, size: size).fill(using: .sourceOver)
                    let shadow = NSShadow()
                    shadow.shadowBlurRadius = 24
                    shadow.shadowOffset = NSSize(width: 0, height: -8)
                    shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
                    NSGraphicsContext.saveGraphicsState()
                    shadow.set()
                    NSColor.windowBackgroundColor.setFill()
                    NSBezierPath(roundedRect: rect, xRadius: 16, yRadius: 16).fill()
                    NSGraphicsContext.restoreGraphicsState()
                    rep.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
                }
            }
        }
        context.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()
        return output
    }

    private func save(_ rep: NSBitmapImageRep, _ name: String) {
        guard let data = rep.representation(using: .png, properties: [:]) else { return }
        let url = folder.appending(path: "\(name).png")
        do {
            try data.write(to: url, options: .atomic)
            written.append(url.path)
            print("capture \(url.path)")
        } catch {
            FileHandle.standardError.write(Data("échec d'écriture \(url.path)\n".utf8))
        }
    }

    private var sidebarWindow: NSWindow?

    /// Zone de la barre latérale sous la barre d'outils, dans le repère de l'image.
    private func sidebarRect(_ window: NSWindow, _ frameView: NSView) -> NSRect? {
        guard let glass = glassViews(in: frameView).first(where: { $0.frame.height > 200 }) else { return nil }
        let rect = place(glass, in: frameView)
        let toolbarHeight = max(0, frameView.bounds.height - window.contentLayoutRect.height)
        return NSRect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height - toolbarHeight)
    }

    /// La même SidebarView (mêmes données, même sélection), rendue hors du verre.
    private func renderSidebar(size: NSSize, behind window: NSWindow) -> NSBitmapImageRep? {
        let helper: NSWindow
        if let existing = sidebarWindow {
            helper = existing
        } else {
            helper = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless],
                              backing: .buffered, defer: false)
            helper.isReleasedWhenClosed = false
            helper.backgroundColor = .clear
            helper.isOpaque = false
            helper.contentView = NSHostingView(rootView: SidebarView(standIn: true).environment(store))
            sidebarWindow = helper
        }
        helper.appearance = NSApplication.shared.appearance
        helper.setContentSize(size)
        helper.setFrameOrigin(window.frame.origin)
        helper.order(.below, relativeTo: window.windowNumber)
        guard let view = helper.contentView else { return nil }
        view.layoutSubtreeIfNeeded()
        helper.displayIfNeeded()
        return render(view)
    }

    /// Fenêtre active pour le rendu (interrupteurs en couleur, sélection bleue).
    private func activateForCapture() {
        let selector = NSSelectorFromString("activateIgnoringOtherApps:")
        let app = NSApplication.shared
        guard app.responds(to: selector) else {
            app.activate()
            return
        }
        typealias Activate = @convention(c) (AnyObject, Selector, Bool) -> Void
        unsafeBitCast(app.method(for: selector), to: Activate.self)(app, selector, true)
    }

    /// Une vue seule (accueil, feuille), rendue dans sa propre fenêtre.
    private func captureAlone(_ view: some View, _ name: String, appearance: NSAppearance?) async {
        await captureMenuPanel(theme: "", appearance: appearance, root: AnyView(view.background(.background)), name: name)
    }

    /// Le panneau de la barre des menus, rendu dans une petite fenêtre à part.
    private func captureMenuPanel(theme: String, appearance: NSAppearance?, root: AnyView? = nil, name: String? = nil) async {
        let hosting = NSHostingView(rootView: (root ?? AnyView(MenuBarPanel())).environment(store))
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 340, height: 600), styleMask: [.borderless],
                             backing: .buffered, defer: false)
        panel.appearance = appearance
        panel.isReleasedWhenClosed = false
        panel.contentView = hosting
        hosting.layoutSubtreeIfNeeded()
        let size = hosting.fittingSize
        panel.setContentSize(size)
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        panel.setFrameTopLeftPoint(NSPoint(x: visible.maxX - size.width - 20, y: visible.maxY - 10))
        panel.orderFrontRegardless()
        await settle(0.8)
        hosting.layoutSubtreeIfNeeded()
        if let image = render(hosting),
           let output = flatten([.image(image, hosting.bounds)], size: hosting.bounds.size,
                                scale: CGFloat(image.pixelsWide) / max(hosting.bounds.width, 1),
                                appearance: panel.effectiveAppearance) {
            save(output, name ?? "13-barre-des-menus-\(theme)")
        }
        panel.orderOut(nil)
        panel.close()
    }

    // MARK: Attente

    private func settle(_ seconds: Double) async {
        try? await Task.sleep(for: .seconds(seconds))
    }

    private func waitUntil(seconds: Double, _ condition: @MainActor () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while ContinuousClock.now < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return condition()
    }

    private func finish(code: Int32, message: String) {
        let line = message + "\n"
        if code == 0 {
            FileHandle.standardOutput.write(Data(line.utf8))
        } else {
            FileHandle.standardError.write(Data(line.utf8))
        }
        exit(code)
    }
}
