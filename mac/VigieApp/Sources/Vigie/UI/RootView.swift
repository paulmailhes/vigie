import SwiftUI

/// La fenêtre (maquette A) : barre latérale à gauche, détail à droite.
struct RootView: View {
    @Environment(VigieStore.self) private var store
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        @Bindable var store = store
        NavigationSplitView {
            SidebarView()
        } detail: {
            DetailView()
                .overlay(alignment: .top) {
                    if showBanner {
                        EngineBanner(connection: store.connection, restarting: store.restarting) {
                            store.restartEngine()
                        }
                        .padding(.top, 10)
                        .transition(.move(edge: .top).combined(with: .opacity))
                    }
                }
                .overlay(alignment: .bottom) {
                    if let toast = store.toast {
                        ToastView(toast: toast) { store.dismissToast($0) }
                            .padding(.bottom, 16)
                            .padding(.horizontal, 24)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                }
                .animation(.smooth, value: store.toast?.id)
                .animation(.smooth, value: showBanner)
        }
        .toolbar { MainToolbar(store: store) }
        .sheet(item: $store.changeRequest) { item in
            ChangeAnswerSheet(item: item)
        }
        .sheet(item: $store.blockedRequest) { item in
            BlockedActionSheet(item: item)
        }
        .frame(minWidth: 960, minHeight: 620)
        .sheet(isPresented: $store.showOnboarding) {
            OnboardingView()
        }
        .sheet(item: $store.answerRequest) { item in
            AnswerQuestionSheet(item: item)
        }
        .sheet(isPresented: Binding(get: { store.whatsNew != nil && !store.showOnboarding },
                                    set: { if !$0 { store.whatsNew = nil } })) {
            WhatsNewSheet(releases: store.whatsNew ?? [])
        }
        .onAppear {
            store.openMainWindow = { openWindow(id: VigieApp.mainWindowID) }
            if !UserDefaults.standard.bool(forKey: OnboardingView.doneKey) && !LaunchOptions.current.isViewer {
                store.showOnboarding = true
            }
        }
    }

    private var showBanner: Bool {
        switch store.connection {
        case .down, .failing: true
        case .connecting, .ok: false
        }
    }
}

/// Le contenu de droite selon la rubrique choisie.
struct DetailView: View {
    @Environment(VigieStore.self) private var store

    var body: some View {
        switch store.route {
        case .overview, nil:
            OverviewView()
        case .conversation(let id):
            ConversationView(conversationID: id)
                .id(id)
        case .account(let id):
            AccountsView(highlight: id)
        case .mcp:
            MCPView()
        }
    }
}

/// Affiché tant que la première réponse du moteur n'est pas arrivée.
struct LoadingView: View {
    @Environment(VigieStore.self) private var store

    var body: some View {
        if store.connection == .down {
            ContentUnavailableView {
                Label("Le moteur de Vigie ne répond pas", systemImage: "bolt.horizontal.circle")
            } description: {
                Text("Relance-le, puis patiente quelques secondes.")
            } actions: {
                Button("Relancer", systemImage: "arrow.clockwise") { store.restartEngine() }
                    .glassButton(.primary)
            }
        } else {
            ProgressView("Lecture du moteur…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
