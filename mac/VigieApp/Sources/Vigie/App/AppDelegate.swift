import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var snapshotRunner: SnapshotRunner?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let store = VigieStore.shared
        if let folder = LaunchOptions.current.snapshotFolder {
            guard store.isDemo else {
                FileHandle.standardError.write(Data("--snapshot demande VIGIE_FIXTURES=<dossier>\n".utf8))
                exit(2)
            }
            store.start()
            let runner = SnapshotRunner(store: store, folder: folder)
            snapshotRunner = runner
            runner.start()
            return
        }
        // Visionneuse (--open <id>) : une conversation à l'écran, sans notifications (l'app principale s'en charge).
        if let id = LaunchOptions.current.openConversation {
            store.route = switch id {
            case "overview": .overview
            case "mcp": .mcp
            case "agents": .agents
            case "history": .history
            default: .conversation(id)
            }
            store.start()
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(1))
                self.showViewerWindow(store: store)
            }
            return
        }
        // App glissée dans Applications : elle installe ou met à jour le moteur qu'elle contient, et s'ouvre à la
        // connexion par elle-même. Ouverte depuis le DMG : on demande d'abord de la glisser dans Applications.
        if EngineBootstrap.placement == .mountedOrTranslocated && EngineBootstrap.bundledEngine != nil {
            EngineBootstrap.askToMoveAndQuit()
            return
        }
        if EngineBootstrap.needed {
            store.setup = .installing // tout de suite : pas d'alerte « moteur arrêté » avant que l'installation démarre
            Task { await store.runSetup() }
        }
        EngineBootstrap.registerLoginItem()
        Notifier.shared.start(store: store)
        WindowVisibility.start(store: store)
        store.start()
    }

    /// Visionneuse : la fenêtre principale si SwiftUI l'a créée, sinon une fenêtre faite à la main.
    private var viewerWindow: NSWindow?
    private func showViewerWindow(store: VigieStore) {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        if let window = app.windows.first(where: { $0.canBecomeMain && $0.contentView != nil && !($0 is NSPanel) }) {
            window.setContentSize(NSSize(width: 1400, height: 900))
            window.center()
            window.makeKeyAndOrderFront(nil)
        } else {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 900),
                                  styleMask: [.titled, .closable, .resizable, .miniaturizable],
                                  backing: .buffered, defer: false)
            window.title = "Vigie"
            window.contentView = NSHostingView(rootView: RootView().environment(store).tint(Theme.action))
            window.center()
            window.makeKeyAndOrderFront(nil)
            viewerWindow = window
        }
        app.activate()
    }

    /// La fenêtre se ferme, Vigie reste dans la barre des menus.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    /// Clic sur l'icône du Dock sans fenêtre ouverte : on rouvre la fenêtre.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            VigieStore.shared.openMainWindow?()
        }
        return true
    }
}

/// Arguments de lancement.
struct LaunchOptions: Sendable {
    let snapshotFolder: URL?
    /// --open <id> : s'ouvre sur cette conversation, en visionneuse (captures d'écran sur les vraies données).
    let openConversation: String?

    var isSnapshot: Bool { snapshotFolder != nil }
    var isViewer: Bool { snapshotFolder != nil || openConversation != nil }

    static let current = LaunchOptions(arguments: ProcessInfo.processInfo.arguments)

    init(arguments: [String]) {
        if let index = arguments.firstIndex(of: "--snapshot"), index + 1 < arguments.count {
            let path = (arguments[index + 1] as NSString).expandingTildeInPath
            snapshotFolder = URL(filePath: path, directoryHint: .isDirectory)
        } else {
            snapshotFolder = nil
        }
        if let index = arguments.firstIndex(of: "--open"), index + 1 < arguments.count {
            openConversation = arguments[index + 1]
        } else {
            openConversation = nil
        }
    }
}
