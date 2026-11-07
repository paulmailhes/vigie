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
            GoCommands(store: store)
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

/// Le menu Aller : Retour / Suivant (⌘[ ⌘]), les pages (⌘1 à ⌘6), la conversation suivante qui t'attend (⌘J) et
/// les conversations ouvertes (⌥⌘1 à ⌥⌘9) : la barre latérale ne prend pas le focus clavier, tout passe par ici.
/// Navigation seulement : aucun raccourci ne décide (Autoriser reste un clic).
struct GoCommands: Commands {
    let store: VigieStore

    var body: some Commands {
        CommandMenu("Aller") {
            Button("Retour") { store.goBack() }
                .keyboardShortcut("[", modifiers: .command)
                .disabled(!store.canGoBack)
            Button("Suivant") { store.goForward() }
                .keyboardShortcut("]", modifiers: .command)
                .disabled(!store.canGoForward)
            Divider()
            Button("Vue d'ensemble") { store.route = .overview }
                .keyboardShortcut("1", modifiers: .command)
            Button("Comptes") { store.showAccounts(nil) }
                .keyboardShortcut("2", modifiers: .command)
            Button("MCP") { store.route = .mcp }
                .keyboardShortcut("3", modifiers: .command)
            Button("Agents") { store.route = .agents }
                .keyboardShortcut("4", modifiers: .command)
            Button("Historique") { store.route = .history }
                .keyboardShortcut("5", modifiers: .command)
            Button("En fond") { store.route = .background }
                .keyboardShortcut("6", modifiers: .command)
            Divider()
            Button("Suivante qui t'attend") { store.showNextWaiting() }
                .keyboardShortcut("j", modifiers: .command)
                .disabled(store.waitingConversationIDs.isEmpty)
            Section("Conversations") {
                ForEach(Array(store.conversations.filter(\.isOpen).prefix(9).enumerated()), id: \.element.id) { index, conversation in
                    Button(conversation.shortTitle) { store.route = .conversation(conversation.id) }
                        .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: [.command, .option])
                }
            }
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
}
