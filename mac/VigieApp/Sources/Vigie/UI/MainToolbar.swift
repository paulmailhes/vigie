import SwiftUI

/// Barre d'outils de la fenêtre : l'interrupteur Auto-accept (contrôle principal) et le menu Questions.
struct MainToolbar: ToolbarContent {
    @Bindable var store: VigieStore

    var body: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            GuardsButton(store: store)
        }
        ToolbarItem(placement: .primaryAction) {
            QuestionsMenu(store: store)
        }
        ToolbarItem(placement: .primaryAction) {
            AutoAcceptSwitch(store: store)
        }
    }
}

struct AutoAcceptSwitch: View {
    @Bindable var store: VigieStore

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: store.autoAccept ? "binoculars.fill" : "binoculars")
                .foregroundStyle(.secondary)
                .contentTransition(.symbolEffect(.replace))
            Text("Auto-accept")
            Toggle("Auto-accept", isOn: $store.autoAccept)
                .toggleStyle(.switch)
                .labelsHidden()
                .controlSize(.small)
        }
        .padding(.horizontal, 10)
        .help(store.autoAccept ? "Claude valide tout seul, sauf les garde-fous" : "Claude te demande avant d'agir")
        .accessibilityElement(children: .combine)
    }
}

struct QuestionsMenu: View {
    @Bindable var store: VigieStore

    var body: some View {
        Menu {
            Toggle("Quand je ne suis pas là, Claude choisit l'option recommandée", isOn: $store.questionsAuto)
            Picker("Attendre avant de choisir", selection: $store.questionWaitMin) {
                ForEach([5, 10, 20, 30, 60], id: \.self) { minutes in
                    Text("\(minutes) min").tag(minutes)
                }
            }
            .disabled(!store.questionsAuto)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: store.questionsAuto ? "questionmark.bubble.fill" : "questionmark.bubble")
                Text("Questions")
            }
        }
        .accessibilityLabel("Questions")
        .help("Questions de Claude quand tu n'es pas là")
    }
}

/// Ouvre les réglages des garde-fous (où décider des actions sensibles, règles).
struct GuardsButton: View {
    @Bindable var store: VigieStore
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        Button {
            store.settingsTab = .guards
            openSettings()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: Icon.guardRule)
                Text("Garde-fous")
            }
        }
        .help("Actions sensibles : à valider dans ta conversation ou dans Vigie")
    }
}
