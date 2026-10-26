import AppKit

/// Rythme des relevés : la fenêtre principale est-elle à l'écran (ni réduite, ni cachée, ni recouverte, ni sur un
/// autre bureau) ? Les écrans dorment-ils ? Fenêtre invisible, Vigie ne relit plus ses pages et espace la vue
/// d'ensemble (VigieStore.start).
@MainActor
enum WindowVisibility {
    private static var observers: [NSObjectProtocol] = []

    static func start(store: VigieStore) {
        guard observers.isEmpty else { return }
        let app = NotificationCenter.default
        for name in [NSWindow.didChangeOcclusionStateNotification, NSWindow.didMiniaturizeNotification,
                     NSWindow.didDeminiaturizeNotification, NSWindow.willCloseNotification,
                     NSApplication.didHideNotification, NSApplication.didUnhideNotification] {
            observers.append(app.addObserver(forName: name, object: nil, queue: .main) { _ in
                // après coup : à la fermeture, la fenêtre est encore affichée au moment de l'avis
                DispatchQueue.main.async { MainActor.assumeIsolated { store.setWindowVisible(mainWindowVisible()) } }
            })
        }
        let workspace = NSWorkspace.shared.notificationCenter
        observers.append(workspace.addObserver(forName: NSWorkspace.screensDidSleepNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { store.setScreensAsleep(true) }
        })
        observers.append(workspace.addObserver(forName: NSWorkspace.screensDidWakeNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { store.setScreensAsleep(false) }
        })
        store.setWindowVisible(mainWindowVisible())
    }

    /// La fenêtre principale (scène « main ») ; à défaut d'identifiant, toute fenêtre ordinaire de l'app.
    static func mainWindowVisible() -> Bool {
        let windows = NSApp.windows
        let main = windows.filter { $0.identifier?.rawValue.hasPrefix(VigieApp.mainWindowID) == true }
        let candidates = main.isEmpty ? windows.filter { $0.canBecomeMain && !($0 is NSPanel) } : main
        return candidates.contains { $0.isVisible && !$0.isMiniaturized && $0.occlusionState.contains(.visible) }
    }
}
