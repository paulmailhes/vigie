import SwiftUI

/// Un MCP qui passe par la passerelle de Vigie : autorisé une fois pour tous les comptes, avec ses espaces
/// (une autorisation par espace, par exemple un espace Webflow par client) et le passage de l'un à l'autre en un clic.
struct GatewayControls: View {
    @Environment(VigieStore.self) private var store
    let name: String
    let server: GatewayServer
    @State private var askingLabel = false
    @State private var renaming = false
    @State private var label = ""
    @State private var busy = false

    var body: some View {
        HStack(spacing: 6) {
            if server.needsAuthorization {
                AsyncButton(server.profiles.isEmpty ? "Autoriser" : "Réautoriser") {
                    await store.gateway("authorize", name: name, server.active.map { ["profileId": .string($0)] } ?? [:])
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.warn)
                .controlSize(.small)
                .help("Ouvre la page du service : une seule autorisation, valable pour tous tes comptes")
            }
            if server.open == true {
                Label("Sans autorisation", systemImage: "checkmark")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else if !server.profiles.isEmpty {
                spaces
            }
        }
        .fixedSize()
        .alert("Nouvel espace", isPresented: $askingLabel) {
            TextField("Nom (par exemple, le client)", text: $label)
            Button("Autoriser") {
                let name = label.trimmingCharacters(in: .whitespaces)
                run { await store.gateway("authorize", name: self.name, ["label": .string(name.isEmpty ? "Espace" : name)]) }
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
                Label(server.activeProfile?.label ?? "Espace", systemImage: server.needsAuthorization ? "exclamationmark.triangle" : "checkmark.circle")
            }
        }
        .menuStyle(.button)
        .glassButton()
        .help(server.profiles.count > 1 ? "Change d'espace en un clic : tous tes comptes suivent" : "Ajoute un autre espace (un client, un compte) pour passer de l'un à l'autre en un clic")
    }

    private func run(_ work: @escaping @MainActor () async -> Void) {
        busy = true
        Task { @MainActor in
            await work()
            busy = false
        }
    }
}

/// Un MCP en ligne encore branché compte par compte : le faire passer par Vigie (une autorisation pour tous).
struct GatewayMigrateButton: View {
    @Environment(VigieStore.self) private var store
    let name: String

    var body: some View {
        AsyncButton("Une autorisation pour tous", systemImage: "arrow.triangle.merge") {
            await store.gateway("migrate", name: name)
        }
        .glassButton()
        .controlSize(.small)
        .help("Vigie se connecte une fois à ce service, et tous tes comptes passent par lui : plus rien à autoriser compte par compte")
    }
}
