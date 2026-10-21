import SwiftUI

/// « Ajouter un compte » : un nom, puis « Connecter » sur sa carte.
struct AddAccountSheet: View {
    @Environment(VigieStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                SheetIcon(symbol: "person.crop.circle.badge.plus")
                Text("Ajouter un compte").font(.title3.bold())
            }
            TextField("Nom du compte", text: $label, prompt: Text("Travail 3"))
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onSubmit(add)
            Text("Ensuite, « Connecter » sur sa carte.")
                .foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("Annuler") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .glassButton()
                Button("Ajouter", action: add)
                    .keyboardShortcut(.defaultAction)
                    .glassButton(.primary)
                    .disabled(trimmed.isEmpty)
            }
            .controlSize(.large)
        }
        .padding(24)
        .frame(width: 420)
        .onAppear { focused = true }
    }

    private var trimmed: String { label.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func add() {
        guard !trimmed.isEmpty else { return }
        let name = trimmed
        Task { await store.createAccount(label: name) }
        dismiss()
    }
}

/// Grande icône monochrome en tête d'une feuille.
struct SheetIcon: View {
    let symbol: String

    var body: some View {
        Image(systemName: symbol)
            .symbolRenderingMode(.hierarchical)
            .font(.system(size: 26))
            .foregroundStyle(.secondary)
            .frame(width: 34, height: 34)
            .accessibilityHidden(true)
    }
}
