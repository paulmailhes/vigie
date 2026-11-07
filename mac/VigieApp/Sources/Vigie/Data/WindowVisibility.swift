import AppKit

/// Rythme des relevés : la fenêtre principale est-elle à l'écran (ni réduite, ni cachée, ni recouverte, ni sur un
/// autre bureau) ? Les écrans dorment-ils ? Fenêtre invisible, Vigie ne relit plus ses pages et espace la vue
/// d'ensemble (VigieStore.start).
/// Présence (« Pendant ton absence ») : une autre mesure. Une fenêtre recouverte ou sur un autre bureau ne fait pas
/// une absence (tu codes dans VS Code, Vigie derrière) ; des écrans en veille, une session verrouillée, l'app cachée
/// (⌘H) ou fermée, la fenêtre réduite ou fermée, oui. L'app qui se ferme compte comme un départ.
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
                DispatchQueue.main.async { MainActor.assumeIsolated { update(store) } }
            })
        }
        // session verrouillée (écran de verrouillage, changement d'utilisateur) : absent, même écrans allumés
        let distributed = DistributedNotificationCenter.default()
        for (name, locked) in [("com.apple.screenIsLocked", true), ("com.apple.screenIsUnlocked", false)] {
            observers.append(distributed.addObserver(forName: Notification.Name(name), object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { store.setScreenLocked(locked) }
            })
        }
        let workspace = NSWorkspace.shared.notificationCenter
        observers.append(workspace.addObserver(forName: NSWorkspace.screensDidSleepNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { store.setScreensAsleep(true) }
        })
        observers.append(workspace.addObserver(forName: NSWorkspace.screensDidWakeNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { store.setScreensAsleep(false) }
        })
        // tout de suite (pas après coup) : l'app n'attend pas pour se fermer
        observers.append(app.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { store.appWillQuit() }
        })
        update(store)
    }

    private static func update(_ store: VigieStore) {
        store.setWindowVisible(mainWindowVisible(), present: mainWindowPresent())
    }

    /// La fenêtre principale (scène « main ») ; à défaut d'identifiant, toute fenêtre ordinaire de l'app.
    private static var mainWindows: [NSWindow] {
        let windows = NSApp.windows
        let main = windows.filter { $0.identifier?.rawValue.hasPrefix(VigieApp.mainWindowID) == true }
        return main.isEmpty ? windows.filter { $0.canBecomeMain && !($0 is NSPanel) } : main
    }

    /// À l'écran pour de vrai : ni réduite, ni cachée, ni recouverte, ni sur un autre bureau (rythme des relevés).
    static func mainWindowVisible() -> Bool {
        mainWindows.contains { $0.isVisible && !$0.isMiniaturized && $0.occlusionState.contains(.visible) }
    }

    /// Ouverte : ni fermée, ni réduite, l'app ni cachée ; recouverte ou sur un autre bureau, elle l'est encore
    /// (présence).
    static func mainWindowPresent() -> Bool {
        !NSApp.isHidden && mainWindows.contains { $0.isVisible && !$0.isMiniaturized }
    }
}
