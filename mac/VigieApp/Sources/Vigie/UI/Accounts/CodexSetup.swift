import SwiftUI

/// Codex en deux étapes : se connecter (navigateur), puis approuver le hook de Vigie dans Codex.
/// Sans la deuxième étape, Codex ne laisse pas Vigie valider à ta place : pas d'auto-accept.
struct CodexSetupSteps: View {
    @Environment(VigieStore.self) private var store
    let account: Account?
    /// Outils cochés dans l'accueil : les instructions pour VS Code, pour l'app ChatGPT, ou les deux.
    var tools: ToolsChoice? = nil
    /// Relit les comptes elle-même (accueil) ; la page Comptes le fait déjà.
    var polls = true

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            step(1, done: account?.isConnected == true, title: "Connexion à ton compte ChatGPT") {
                if account?.isConnected == true {
                    Text("Connecté\(account?.plan.map { " · forfait \($0)" } ?? "")")
                        .foregroundStyle(.secondary)
                } else {
                    HStack(spacing: 10) {
                        AsyncButton(account?.connecting == true ? "Connexion en cours…" : "Connecter Codex") { await store.codexLogin() }
                        .glassButton(.primary)
                        .disabled(account?.connecting == true)
                        Text("La page de connexion d'OpenAI s'ouvre dans ton navigateur.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            step(2, done: account?.hook?.trusted == true, title: "Le hook de Vigie approuvé dans Codex") {
                if account?.hook?.trusted == true {
                    Text("Approuvé : l'auto-accept marche pour Codex.")
                        .foregroundStyle(.secondary)
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Codex demande de faire confiance une fois à un nouveau hook (c'est une sécurité d'OpenAI). Sans ça, pas d'auto-accept pour Codex.")
                            .fixedSize(horizontal: false, vertical: true)
                        if tools?.codexVSCode ?? true {
                            Label("Dans VS Code : ouvre le panneau Codex. En bas, un bandeau « Review hooks » : clique dessus et accepte les deux hooks « Vigie ».",
                                  systemImage: "chevron.left.forwardslash.chevron.right")
                                .font(.callout)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if tools?.codexApp ?? (store.tools?.detected?.codexApp == true) {
                            Label("Dans l'app ChatGPT : ouvre Codex. Un message te propose de vérifier les hooks (« Review hooks ») : accepte les deux hooks « Vigie ».",
                                  systemImage: "macwindow")
                                .font(.callout)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Text("Vigie le voit tout seul dès que c'est fait.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        AsyncButton("Vérifier", systemImage: "arrow.clockwise") { await store.refreshAccounts() }
                        .glassButton()
                        .controlSize(.small)
                    }
                    .disabled(account?.isConnected != true)
                    .opacity(account?.isConnected == true ? 1 : Theme.dim)
                }
            }
        }
        // l'état change hors de Vigie (navigateur, Codex) : relu toutes les 3 s tant que c'est à l'écran
        .task(id: store.windowVisible) {
            guard polls else { return }
            while !Task.isCancelled && store.windowVisible {
                try? await Task.sleep(for: .seconds(3))
                await store.refreshAccounts()
            }
        }
    }

    private func step<Content: View>(_ number: Int, done: Bool, title: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle().fill(done ? AnyShapeStyle(Theme.live) : AnyShapeStyle(.quaternary)).frame(width: 24, height: 24)
                if done {
                    Image(systemName: "checkmark").font(.caption.bold()).foregroundStyle(.white)
                } else {
                    Text("\(number)").font(.caption.bold())
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.headline)
                content()
            }
        }
    }
}

