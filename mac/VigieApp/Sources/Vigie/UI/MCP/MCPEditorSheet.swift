import SwiftUI

/// Ajouter ou modifier un MCP : formulaire simple, ou commande « claude mcp add … » collée puis analysée.
struct MCPEditorSheet: View {
    @Environment(VigieStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let request: MCPEditorRequest
    let projects: [KnownProject]

    enum Mode: String, CaseIterable, Identifiable {
        case form, paste
        var id: String { rawValue }
        var title: String { self == .form ? "Formulaire" : "Coller une commande" }
    }

    enum Destination: String, CaseIterable, Identifiable {
        case mac, project
        var id: String { rawValue }
        var title: String { self == .mac ? "Sur ton Mac" : "Dans un projet" }
    }

    @State private var mode: Mode = .form
    @State private var draft = MCPDraft()
    @State private var destination: Destination = .mac
    @State private var projectPath = ""
    @State private var accountIDs: Set<String> = []
    @State private var pasted = ""
    @State private var pasteError: String?
    @State private var sending = false
    @State private var prepared = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                SheetIcon(symbol: "puzzlepiece.extension")
                Text(title).font(.title3.bold())
                Spacer()
                if !isEditing {
                    Picker("Mode", selection: $mode) {
                        ForEach(Mode.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .fixedSize()
                }
            }
            .padding([.horizontal, .top], 24)
            .padding(.bottom, 8)

            if mode == .paste {
                pasteView
            } else {
                formView
            }

            HStack {
                if draft.containsMaskedValue {
                    Label("Ressaisis les valeurs masquées (••••)", systemImage: "eye.slash")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Annuler") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .glassButton()
                if mode == .form {
                    Button(isEditing ? "Enregistrer" : "Ajouter", action: submit)
                        .keyboardShortcut(.defaultAction)
                        .glassButton(.primary)
                        .disabled(!canSubmit)
                } else {
                    Button("Analyser", action: analyse)
                        .keyboardShortcut(.defaultAction)
                        .glassButton(.primary)
                        .disabled(pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .controlSize(.large)
            .padding(24)
        }
        .frame(width: 620)
        .frame(minHeight: 420, idealHeight: 560)
        .onAppear(perform: prepare)
    }

    private var isEditing: Bool {
        switch request {
        case .editUser, .editProject: true
        case .addUser, .addProject: false
        }
    }

    private var title: String {
        switch request {
        case .addUser, .addProject: "Ajouter un MCP"
        case .editUser(let server): "Modifier « \(server.name) »"
        case .editProject(_, let server): "Modifier « \(server.name) »"
        }
    }

    // MARK: Coller

    private var pasteView: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Colle la commande donnée par le service :")
                .foregroundStyle(.secondary)
            TextEditor(text: $pasted)
                .font(.body.monospaced())
                .scrollContentBackground(.hidden)
                .padding(8)
                .background(.quinary, in: .rect(cornerRadius: 10))
                .frame(minHeight: 140)
                .overlay(alignment: .topLeading) {
                    if pasted.isEmpty {
                        Text("claude mcp add --transport http figma https://mcp.figma.com/mcp")
                            .font(.body.monospaced())
                            .foregroundStyle(.tertiary)
                            .padding(13)
                            .allowsHitTesting(false)
                    }
                }
            if let pasteError {
                Label(pasteError, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 8)
        .frame(maxHeight: .infinity, alignment: .top)
    }

    private func analyse() {
        switch MCPCommandParser.parse(pasted) {
        case .success(let parsed):
            draft = parsed
            if parsed.scope == "project" {
                destination = .project
                if projectPath.isEmpty { projectPath = projects.first?.path ?? "" }
            } else {
                destination = .mac
            }
            pasteError = nil
            mode = .form
        case .failure(let failure):
            pasteError = switch failure {
            case .notACommand: "Ce n'est pas une commande « claude mcp add »"
            case .missingName: "Il manque le nom du MCP"
            case .missingTarget: "Il manque la commande ou l'adresse"
            case .badJSON: "La configuration JSON est illisible"
            }
        }
    }

    // MARK: Formulaire

    private var formView: some View {
        Form {
            Section {
                Picker("Où", selection: $destination) {
                    ForEach(Destination.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .disabled(isEditing)
                if destination == .project {
                    Picker("Projet", selection: $projectPath) {
                        if projectPath.isEmpty { Text("Choisir…").tag("") }
                        ForEach(projects) { project in
                            Text(project.name).tag(project.path)
                        }
                    }
                    .disabled(isEditing)
                }
                TextField("Nom", text: $draft.name, prompt: Text("figma-pro"))
                    .disabled(isEditing)
            }

            Section {
                Picker("Type", selection: $draft.transport) {
                    ForEach(MCPDraft.Transport.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                if draft.transport == .stdio {
                    TextField("Commande", text: $draft.command, prompt: Text("npx"))
                    TextField("Arguments", text: $draft.arguments, prompt: Text("-y @supabase/mcp-server-supabase"))
                } else {
                    TextField("Adresse", text: $draft.url, prompt: Text("https://mcp.exemple.com/mcp"))
                }
            }

            Section {
                if draft.transport == .stdio {
                    PairsEditor(pairs: $draft.env, keyPrompt: "NOM", addTitle: "Ajouter une variable")
                } else {
                    PairsEditor(pairs: $draft.headers, keyPrompt: "Authorization", addTitle: "Ajouter un en-tête")
                }
            } header: {
                Text(draft.transport == .stdio ? "Variables (secrètes)" : "En-têtes (secrets)")
            }

            if destination == .mac {
                Section("Comptes") {
                    ForEach(store.accounts) { account in
                        Toggle(account.displayName, isOn: accountBinding(account.id))
                    }
                }
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
    }

    private func accountBinding(_ id: String) -> Binding<Bool> {
        Binding {
            accountIDs.contains(id)
        } set: { on in
            if on { accountIDs.insert(id) } else { accountIDs.remove(id) }
        }
    }

    private var canSubmit: Bool {
        guard draft.isComplete, !draft.containsMaskedValue, !sending else { return false }
        if destination == .project { return !projectPath.isEmpty }
        return !accountIDs.isEmpty
    }

    // MARK: Préparation et envoi

    private func prepare() {
        guard !prepared else { return }
        prepared = true
        accountIDs = Set(store.accounts.map(\.id))
        switch request {
        case .addUser:
            destination = .mac
        case .addProject(let path):
            destination = .project
            projectPath = path ?? projects.first?.path ?? ""
        case .editUser(let server):
            destination = .mac
            draft = MCPDraft.from(name: server.name, type: server.type, target: server.target, config: server.config)
            accountIDs = Set(server.accounts)
        case .editProject(let path, let server):
            destination = .project
            projectPath = path
            draft = MCPDraft.from(name: server.name, type: server.type, target: server.target, config: server.config)
        }
    }

    private func submit() {
        guard canSubmit else { return }
        sending = true
        let action = isEditing ? "update" : "add"
        let config = draft.config
        let name = draft.name.trimmingCharacters(in: .whitespaces)
        let path = projectPath
        let ids = store.accounts.map(\.id).filter { accountIDs.contains($0) }
        let toProject = destination == .project
        Task {
            let ok = if toProject {
                await store.mcpProject(action, path: path, name: name, config: config)
            } else {
                await store.mcpUser(action, name: name, config: config, accounts: ids)
            }
            sending = false
            if ok {
                store.show(info: isEditing ? "« \(name) » modifié" : "« \(name) » ajouté")
                dismiss()
            }
        }
    }
}

/// Liste de paires clé / valeur secrète (variables d'environnement ou en-têtes).
struct PairsEditor: View {
    @Binding var pairs: [MCPDraft.Pair]
    let keyPrompt: String
    let addTitle: String

    var body: some View {
        ForEach($pairs) { $pair in
            HStack(spacing: 8) {
                TextField("Nom", text: $pair.key, prompt: Text(keyPrompt))
                    .labelsHidden()
                    .font(.body.monospaced())
                    .frame(maxWidth: 200)
                SecureField("Valeur", text: $pair.value, prompt: Text("valeur"))
                    .labelsHidden()
                Button("Retirer", systemImage: "minus.circle.fill") {
                    pairs.removeAll { $0.id == pair.id }
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
            }
        }
        Button(addTitle, systemImage: "plus.circle") {
            pairs.append(MCPDraft.Pair())
        }
        .buttonStyle(.borderless)
    }
}
