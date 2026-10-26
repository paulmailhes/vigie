import SwiftUI

/// Ligne d'état d'un MCP qui passe par la passerelle de Vigie : connecté une fois pour tous les comptes, avec ses
/// espaces (une connexion par espace, par exemple un espace Webflow par client) et le passage de l'un à l'autre en
/// un clic. « Reconnecter » n'apparaît que si le service a coupé l'accès (une coupure réseau n'en est pas une).
struct GatewayLine: View {
    @Environment(VigieStore.self) private var store
    let name: String
    let server: GatewayServer
    @State private var askingLabel = false
    @State private var renaming = false
    @State private var confirmRemove = false
    @State private var label = ""
    @State private var busy = false

    var body: some View {
        Group {
            if server.open == true {
                MCPIssueLine(systemImage: "checkmark.circle", color: .secondary, text: "Pour tous tes comptes, rien à connecter") { EmptyView() }
            } else if server.profiles.isEmpty {
                MCPIssueLine(systemImage: "key", color: Theme.warn, text: "Pas encore connecté : une seule connexion pour tous tes comptes") {
                    authorizeButton("Connecter")
                }
            } else if server.needsAuthorization {
                MCPIssueLine(systemImage: "exclamationmark.triangle.fill", color: Theme.warn,
                             text: "Le service a coupé l'accès à l'espace « \(server.activeProfile?.label ?? "Espace") » : reconnecte-le") {
                    HStack(spacing: 8) {
                        spaces
                        authorizeButton("Reconnecter")
                    }
                }
            } else {
                MCPIssueLine(systemImage: "checkmark.circle", color: .secondary, text: "Connecté une fois pour tous tes comptes") {
                    spaces
                }
            }
        }
        .alert("Nouvel espace", isPresented: $askingLabel) {
            TextField("Nom (par exemple, le client)", text: $label)
            Button("Connecter") {
                let value = label.trimmingCharacters(in: .whitespaces)
                run { await store.gateway("authorize", name: name, ["label": .string(value.isEmpty ? "Espace" : value)]) }
            }
            Button("Annuler", role: .cancel) {}
        } message: {
            Text("Ton navigateur s'ouvre : choisis l'espace à donner à Claude. Ensuite, tu passes d'un espace à l'autre en un clic, sans te reconnecter.")
        }
        .alert("Renommer l'espace", isPresented: $renaming) {
            TextField("Nom", text: $label)
            Button("Renommer") {
                guard let id = server.active else { return }
                let value = label
                run { await store.gateway("rename", name: name, ["profileId": .string(id), "label": .string(value)]) }
            }
            Button("Annuler", role: .cancel) {}
        }
        .confirmationDialog("Retirer l'espace « \(server.activeProfile?.label ?? "Espace") » ?", isPresented: $confirmRemove) {
            Button("Retirer", role: .destructive) {
                guard let id = server.active else { return }
                run { await store.gateway("removeProfile", name: name, ["profileId": .string(id)]) }
            }
            Button("Annuler", role: .cancel) {}
        } message: {
            Text("Sa connexion est oubliée : pour le retrouver, il faudra le reconnecter.")
        }
    }

    private func authorizeButton(_ title: String) -> some View {
        AsyncButton(title) {
            await store.gateway("authorize", name: name, server.active.map { ["profileId": .string($0)] } ?? [:])
        }
        .buttonStyle(.borderedProminent)
        .tint(Theme.warn)
        .controlSize(.small)
        .help("Ouvre la page du service dans ton navigateur : une seule connexion, valable pour tous tes comptes")
    }

    /// Menu des espaces : l'actif coché, puis ajouter, reconnecter, renommer, retirer.
    private var spaces: some View {
        Menu {
            Section("Espace utilisé par tous tes comptes") {
                ForEach(server.profiles) { profile in
                    Button {
                        guard profile.id != server.active else { return }
                        run { await store.gateway("activate", name: name, ["profileId": .string(profile.id)]) }
                    } label: {
                        if profile.id == server.active {
                            Label(profile.label ?? "Espace", systemImage: "checkmark")
                        } else {
                            Text(profile.error == nil ? (profile.label ?? "Espace") : "\(profile.label ?? "Espace") (à reconnecter)")
                        }
                    }
                }
            }
            Divider()
            Button("Ajouter un espace…", systemImage: "plus") {
                label = ""
                askingLabel = true
            }
            Button("Reconnecter cet espace", systemImage: "arrow.clockwise") {
                guard let id = server.active else { return }
                run { await store.gateway("authorize", name: name, ["profileId": .string(id)]) }
            }
            Button("Renommer cet espace…", systemImage: "pencil") {
                label = server.activeProfile?.label ?? ""
                renaming = true
            }
            if server.profiles.count > 1, server.active != nil {
                Button("Retirer cet espace…", systemImage: "trash", role: .destructive) { confirmRemove = true }
            }
        } label: {
            BusyLabel(busy: busy) {
                Text("Espace : \(server.activeProfile?.label ?? "aucun")")
            }
        }
        .menuStyle(.button)
        .controlSize(.small)
        .fixedSize()
        .help(server.profiles.count > 1 ? "Change d'espace en un clic : tous tes comptes suivent, conversations ouvertes comprises" : "Ajoute un autre espace (un client, un compte) pour passer de l'un à l'autre en un clic")
    }

    private func run(_ work: @escaping @MainActor () async -> Void) {
        busy = true
        Task { @MainActor in
            await work()
            busy = false
        }
    }
}
