import SwiftUI

/// Réglages › Général : ce que l'accueil a demandé, à retrouver et à changer à tout moment — les outils avec lesquels
/// tu travailles, et chaque fonctionnalité de Vigie, expliquée ; puis « Revoir l'accueil ».
struct GeneralSettingsView: View {
    @Environment(VigieStore.self) private var store
    @State private var autoSend = AgentAutoSend.allowed

    var body: some View {
        @Bindable var store = store
        Form {
            Section {
                tool("Claude Code dans VS Code", \.claudeVSCode)
                tool("Claude Code dans l'app Claude", \.claudeApp)
                tool("Codex dans VS Code", \.codexVSCode)
                tool("Codex dans l'app ChatGPT", \.codexApp)
            } header: {
                Text("Avec quoi tu travailles")
            } footer: {
                Text("Vigie suit tes conversations là où elles tournent.")
            }

            Section("Fonctionnalités de Vigie") {
                feature("Auto-accept", "Accepte pour toi les demandes d'autorisation de Claude, dans toutes tes conversations. Les actions sensibles (garde-fous) attendent toujours ton accord.",
                        isOn: $store.autoAccept)
                feature("Répondre aux questions quand tu n'es pas là", "Si Claude te pose une question et que tu ne réponds pas en \(store.questionWaitMin) min, Vigie choisit l'option que Claude recommande.",
                        isOn: $store.questionsAuto)
                feature("MCP du compte dans les nouvelles conversations", "Les MCP branchés à ton compte claude.ai (Gmail, Drive…) arrivent dans chaque nouvelle conversation. Coupe-les si le compte est partagé : ce seraient aussi ceux des autres.",
                        isOn: $store.connectorsDefaultOn)
                feature("Mises à jour automatiques", "Vigie installe tout seul ses nouvelles versions et te montre ce qui a changé.",
                        isOn: $store.autoUpdate)
                feature("Arrêter seuls les Chrome sans fenêtre oubliés", "Ceux qu'une conversation a laissés derrière elle : arrêtés quand elle est fermée depuis 6 h et qu'ils ne consomment plus rien. Le reste attend ton clic dans En fond.",
                        isOn: $store.stopForgotten)
                LabeledContent {
                    if autoSend {
                        Label("Autorisé", systemImage: "checkmark")
                            .foregroundStyle(.secondary)
                    } else {
                        Button("Autoriser…") { AgentAutoSend.requestAccess() }
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Agents qui démarrent tout seuls")
                        Text("Avec l'accès Accessibilité, Vigie envoie le message d'un agent dans le champ de Claude et fait confiance au dossier du projet dans VS Code.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .task {
                    while !Task.isCancelled && !autoSend {
                        try? await Task.sleep(for: .seconds(2))
                        autoSend = AgentAutoSend.allowed
                    }
                }
            }

            Section {
                Button("Revoir l'accueil") {
                    store.openMainWindow?()
                    store.showOnboarding = true
                }
            } footer: {
                Text("Les mêmes étapes qu'au premier lancement : outils, actions sensibles, comptes, MCP, fonctionnalités.")
            }
        }
        .formStyle(.grouped)
        .task { if store.tools == nil { await store.refreshTools() } }
    }

    private func tool(_ title: String, _ key: WritableKeyPath<ToolsChoice, Bool>) -> some View {
        let detected = store.tools?.detected?[keyPath: key] == true
        return Toggle(isOn: Binding {
            (store.tools?.chosen ?? store.tools?.detected ?? ToolsChoice(claudeVSCode: true))[keyPath: key]
        } set: { on in
            var choice = store.tools?.chosen ?? store.tools?.detected ?? ToolsChoice(claudeVSCode: true)
            choice[keyPath: key] = on
            guard choice.any else { return } // au moins un
            Task { await store.saveTools(choice) }
        }) {
            HStack {
                Text(title)
                if detected {
                    Text("trouvé sur ton Mac")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func feature(_ title: String, _ text: String, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(text)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
