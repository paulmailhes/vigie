import SwiftUI

/// Une bibliothèque : nom, adresse courte, « Mise à jour il y a 2 h · 3 agents », ce qui ne va pas en orange, puis
/// « Mettre à jour » et « Retirer » (confirmé par la page).
struct AgentLibraryRow: View {
    @Environment(VigieStore.self) private var store
    let library: AgentLibraryInfo
    let count: Int
    let remove: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AgentIcon(symbol: Icon.library)
            VStack(alignment: .leading, spacing: 2) {
                Text(library.displayName)
                    .fontWeight(.semibold)
                if let short = library.shortURL { address(short) }
                // l'âge avance tout seul, même quand rien ne change côté moteur
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    Text(library.summary(now: store.isDemo ? store.now : context.date, count: count))
                        .monospacedDigit()
                }
                .font(.callout)
                .foregroundStyle(.secondary)
                .help(details)
                if let problem = library.problem {
                    Label(problem, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout)
                        .foregroundStyle(Theme.warn)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 4)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 8) {
                AsyncButton("Mettre à jour") { await store.updateAgentLibrary(library) }
                    .glassButton()
                    .disabled(library.status == .updating)
                    .help(library.status == .updating ? "Mise à jour en cours" : "Récupère tout de suite la dernière version du dépôt (sinon, toutes les heures)")
                Button("Retirer", action: remove)
                    .glassButton()
                    .help("Retire la bibliothèque et ses agents de Vigie (le dépôt n'est pas touché)")
            }
        }
        .padding(.vertical, 6)
    }

    /// Un lien vers la page du dépôt (adresse https), sinon l'adresse telle quelle.
    @ViewBuilder
    private func address(_ short: String) -> some View {
        if let page = library.url.flatMap(AgentLibraryAddress.webPage) {
            Link(short, destination: page)
                .font(.callout)
                .help("Ouvre la page du dépôt dans ton navigateur")
        } else {
            Text(short)
                .font(.callout)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
    }

    /// « Version du dépôt : 4f2a9c1 · Ajoutée le 12 octobre 2026 », au survol.
    private var details: String {
        var parts: [String] = []
        if let commit = library.commit { parts.append("Version du dépôt : \(commit)") }
        if let addedAt = library.addedAt {
            parts.append("Ajoutée le \(addedAt.formatted(.dateTime.day().month(.wide).year().locale(Fmt.locale)))")
        }
        return parts.joined(separator: " · ")
    }
}

/// « Ajouter une bibliothèque… » : l'adresse du dépôt, vérifiée à la frappe (le moteur reste l'arbitre). « Ajouter »
/// attend que le moteur ait récupéré le dépôt (jusqu'à 90 s) ; un refus s'affiche dans la feuille, qui reste ouverte.
struct AgentLibraryAddSheet: View {
    @Environment(VigieStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var address: String
    @State private var adding = false
    /// Le dernier refus du moteur : effacé dès que l'adresse change.
    @State private var issue: String?
    @FocusState private var focused: Bool

    /// `address` : déjà remplie (mode captures).
    init(address: String = "") {
        _address = State(initialValue: address)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                SheetIcon(symbol: Icon.library)
                Text("Ajouter une bibliothèque")
                    .font(.title3.bold())
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Adresse du dépôt")
                    .fontWeight(.medium)
                TextField("Adresse du dépôt", text: binding, prompt: Text(AgentLibraryAddress.example))
                    .textFieldStyle(.roundedBorder)
                    .labelsHidden()
                    .focused($focused)
                    .disabled(adding)
                    .onSubmit { Task { await add() } }
                if case .refused(let reason) = check {
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(Theme.warn)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Text("Un dépôt git avec un dossier par agent : Vigie le récupère et le tient à jour toutes les heures. Tes identifiants git (gh, clé SSH) servent tels quels.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let issue {
                Label(issue, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(Theme.alert)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 12) {
                if adding {
                    Text("Jusqu'à 1 min 30 pour un gros dépôt.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Annuler") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .glassButton()
                    .disabled(adding)
                addButton
            }
            .controlSize(.large)
        }
        .padding(24)
        .frame(width: 500)
        .interactiveDismissDisabled(adding)
        .onAppear { focused = true }
    }

    /// Pendant le clonage : « Récupération… ».
    private var addButton: some View {
        Button {
            Task { await add() }
        } label: {
            if adding {
                HStack(spacing: 6) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Récupération…")
                }
            } else {
                Text("Ajouter")
            }
        }
        .keyboardShortcut(.defaultAction)
        .glassButton(.primary)
        .disabled(ready == nil || adding)
    }

    private var binding: Binding<String> {
        Binding {
            address
        } set: { value in
            address = value
            issue = nil
        }
    }

    private var check: AgentLibraryAddress.Check { AgentLibraryAddress.check(address) }

    /// L'adresse à envoyer ; nil : pas encore complète, ou refusée.
    private var ready: String? {
        if case .ready(let url) = check { return url }
        return nil
    }

    private func add() async {
        guard let url = ready, !adding else { return }
        adding = true
        issue = nil
        let refused = await store.addAgentLibrary(url: url)
        adding = false
        if let refused {
            issue = refused
        } else {
            dismiss()
        }
    }
}
