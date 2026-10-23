import SwiftUI

/// Ligne d'état d'un MCP qui passe par la passerelle de Vigie : autorisé une fois pour tous les comptes, avec ses
/// espaces (une autorisation par espace, par exemple un espace Webflow par client) et le passage de l'un à l'autre en
/// un clic. « Réautoriser » n'apparaît que si le service a refusé l'autorisation (une coupure réseau n'en est pas une).
struct GatewayLine: View {
    @Environment(VigieStore.self) private var store
    let name: String
    let server: GatewayServer
    @State private var askingLabel = false
    @State private var renaming = false
    @State private var label = ""
    @State private var busy = false

    var body: some View {
        Group {
            if server.open == true {
                MCPIssueLine(systemImage: "checkmark.circle", color: .secondary, text: "Pour tous tes comptes, sans autorisation à donner") { EmptyView() }
            } else if server.profiles.isEmpty {
                MCPIssueLine(systemImage: "key", color: Theme.warn, text: "Pas encore autorisé : une seule autorisation pour tous tes comptes") {
                    authorizeButton("Autoriser")
                }
            } else if server.needsAuthorization {
                MCPIssueLine(systemImage: "exclamationmark.triangle.fill", color: Theme.warn,
                             text: "Le service a refusé l'autorisation de l'espace « \(server.activeProfile?.label ?? "Espace") »") {
                    HStack(spacing: 8) {
                        spaces
                        authorizeButton("Réautoriser")
                    }
                }
            } else {
                MCPIssueLine(systemImage: "checkmark.circle", color: .secondary, text: "Une autorisation pour tous tes comptes") {
                    spaces
                }
            }
        }
        .alert("Nouvel espace", isPresented: $askingLabel) {
            TextField("Nom (par exemple, le client)", text: $label)
            Button("Autoriser") {
                let value = label.trimmingCharacters(in: .whitespaces)
                run { await store.gateway("authorize", name: name, ["label": .string(value.isEmpty ? "Espace" : value)]) }
            }
            Button("Annuler", role: .cancel) {}
        } message: {
            Text("Ton navigateur s'ouvre : choisis l'espace à donner à Claude. Ensuite, tu passes d'un espace à l'autre en un clic, sans rien réautoriser.")
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
    }

    private func authorizeButton(_ title: String) -> some View {
        AsyncButton(title) {
            await store.gateway("authorize", name: name, server.active.map { ["profileId": .string($0)] } ?? [:])
        }
        .buttonStyle(.borderedProminent)
        .tint(Theme.warn)
        .controlSize(.small)
        .help("Ouvre la page du service : une seule autorisation, valable pour tous tes comptes")
    }

    /// Menu des espaces : l'actif coché, puis ajouter, réautoriser, renommer, retirer.
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
                            Text(profile.error == nil ? (profile.label ?? "Espace") : "\(profile.label ?? "Espace") (à réautoriser)")
                        }
                    }
                }
            }
            Divider()
            Button("Ajouter un espace…", systemImage: "plus") {
                label = ""
                askingLabel = true
            }
            Button("Réautoriser cet espace", systemImage: "arrow.clockwise") {
                guard let id = server.active else { return }
                run { await store.gateway("authorize", name: name, ["profileId": .string(id)]) }
            }
            Button("Renommer cet espace…", systemImage: "pencil") {
                label = server.activeProfile?.label ?? ""
                renaming = true
            }
            if server.profiles.count > 1, let id = server.active {
                Button("Retirer cet espace", systemImage: "trash", role: .destructive) {
                    run { await store.gateway("removeProfile", name: name, ["profileId": .string(id)]) }
                }
            }
        } label: {
            BusyLabel(busy: busy) {
                Text("Espace : \(server.activeProfile?.label ?? "?")")
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
