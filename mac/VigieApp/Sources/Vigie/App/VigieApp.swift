import SwiftUI

/// Vigie : une fenêtre (icône dans le Dock) et une icône dans la barre des menus.
/// Fermer la fenêtre laisse l'app dans la barre des menus.
@main
struct VigieApp: App {
    static let mainWindowID = "main"

    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var store = VigieStore.shared

    init() {
        // --desinscrire (scripts/uninstall.sh) : retire l'ouverture à la connexion, puis quitte sans rien afficher.
        if CommandLine.arguments.contains("--desinscrire") {
            EngineBootstrap.unregisterLoginItem()
            exit(0)
        }
    }

    var body: some Scene {
        Window("Vigie", id: Self.mainWindowID) {
            RootView()
                .environment(store)
                .tint(Theme.action)
        }
        .defaultSize(width: 1280, height: 820)
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandMenu("Aller") {
                Button("Vue d'ensemble") { store.route = .overview }
                    .keyboardShortcut("1", modifiers: .command)
                Button("Comptes") { store.showAccounts(nil) }
                    .keyboardShortcut("2", modifiers: .command)
                Button("MCP") { store.route = .mcp }
                    .keyboardShortcut("3", modifiers: .command)
                Button("Historique") { store.route = .history }
                    .keyboardShortcut("4", modifiers: .command)
                Divider()
                Button("Actualiser") { Task { await store.refreshOverview() } }
                    .keyboardShortcut("r", modifiers: .command)
                Divider()
                Button("Revoir l'accueil") {
                    store.openMainWindow?()
                    store.showOnboarding = true
                }
            }
        }

        Settings {
            SettingsView()
                .environment(store)
        }

        MenuBarExtra(isInserted: .constant(!LaunchOptions.current.isViewer)) {
            MenuBarPanel()
                .environment(store)
                .tint(Theme.action)
        } label: {
            MenuBarLabel(store: store)
        }
        .menuBarExtraStyle(.window)
    }
}
