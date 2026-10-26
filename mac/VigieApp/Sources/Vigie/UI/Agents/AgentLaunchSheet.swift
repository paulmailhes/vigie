import AppKit
import SwiftUI

/// Lancer un agent : son formulaire, le dossier du projet (proposé d'après le nom saisi), puis « Lancer dans VS Code ».
/// Le moteur refuse (champ trop long, dossier refusé…) ou VS Code manque : la feuille reste ouverte, le message
/// s'affiche en bas, au-dessus des boutons.
struct AgentLaunchSheet: View {
    @Environment(VigieStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let agent: AgentInfo

    @State private var values: [String: String] = [:]
    @State private var folder = ""
    /// Le dossier a été changé à la main : il ne suit plus le nom saisi.
    @State private var folderEdited = false
    /// Le dernier lancement n'a pas abouti (refus, VS Code fermé) : effacé dès qu'un champ ou le dossier change.
    @State private var launchIssue: AgentLaunchOutcome?
    /// Le moteur a préparé le dossier : « Annuler » ne défait rien, il devient « Fermer ».
    @State private var prepared = false
    @State private var copied = false
    @FocusState private var focused: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding([.horizontal, .top], 24)
                .padding(.bottom, 14)
            Divider()
            ScrollView {
                // Le dossier juste sous le champ qui le nomme : visible sans défiler, même avec un long formulaire
                VStack(alignment: .leading, spacing: 18) {
                    ForEach(agent.fields) { field in
                        fieldView(field)
                        if field.id == agent.namingField?.id { folderView }
                    }
                    if agent.namingField == nil { folderView }
                }
                .padding(24)
            }
            Divider()
            footer
                .padding(.horizontal, 24)
                .padding(.vertical, 16)
        }
        .frame(width: 620)
        .frame(minHeight: 360, idealHeight: idealHeight)
        .onAppear {
            guard folder.isEmpty else { return }
            folder = suggested
            focused = agent.fields.first?.id
        }
    }

    /// Assez haut pour tout voir quand c'est court ; au-delà, le formulaire défile.
    private var idealHeight: CGFloat {
        let fields = agent.fields.reduce(0) { $0 + ($1.kind.isMultiline ? 215 : 82) }
        return min(780, 340 + CGFloat(fields))
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            SheetIcon(symbol: AgentIcon.resolved(agent.icon))
            VStack(alignment: .leading, spacing: 2) {
                Text(agent.displayName)
                    .font(.title3.bold())
                if let description = agent.description, !description.isEmpty {
                    Text(description)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: Champs

    private func fieldView(_ field: AgentField) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            FieldTitle(text: field.label, required: field.required)
            if field.kind.isMultiline {
                AgentTextArea(text: binding(field), placeholder: field.placeholder ?? (field.kind == .urls ? "https://…" : nil))
                    .focused($focused, equals: field.id)
            } else {
                TextField(field.label, text: binding(field), prompt: Text(field.placeholder ?? (field.kind == .url ? "https://…" : "")))
                    .textFieldStyle(.roundedBorder)
                    .labelsHidden()
                    .focused($focused, equals: field.id)
            }
            if let caption = caption(field) {
                Text(caption)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func caption(_ field: AgentField) -> String? {
        guard field.kind == .urls else { return field.help }
        return field.help.map { "\($0) · une adresse par ligne" } ?? "Une adresse par ligne"
    }

    /// Saisir le nom du client met à jour le dossier proposé, tant qu'il n'a pas été changé à la main.
    private func binding(_ field: AgentField) -> Binding<String> {
        Binding {
            values[field.id] ?? ""
        } set: { value in
            values[field.id] = value
            if !folderEdited { folder = suggested }
            launchIssue = nil
        }
    }

    // MARK: Dossier du projet

    private var suggested: String { Fmt.shortPath(agent.suggestedFolder(values: values)) }

    private var folderBinding: Binding<String> {
        Binding {
            folder
        } set: { value in
            folder = value
            folderEdited = value != suggested
            launchIssue = nil
        }
    }

    private var folderView: some View {
        VStack(alignment: .leading, spacing: 6) {
            FieldTitle(text: "Dossier du projet", required: true)
            HStack(spacing: 8) {
                TextField("Dossier du projet", text: folderBinding, prompt: Text(Fmt.shortPath(agent.parentFolder) + "/cabinet-martin"))
                    .textFieldStyle(.roundedBorder)
                    .labelsHidden()
                Button("Choisir…", action: chooseFolder)
                    .glassButton()
            }
            let note = folderNote
            Text(note.text)
                .font(.caption)
                .foregroundStyle(note.warn ? AnyShapeStyle(Theme.warn) : AnyShapeStyle(.secondary))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// La légende du dossier : d'où vient son nom, ce qui ne va pas, ou ce que Vigie y fera.
    private var folderNote: (text: String, warn: Bool) {
        if !folderEdited, let naming = agent.namingField, Self.clean(values[naming.id], kind: .text).isEmpty {
            return ("Son nom vient de « \(naming.label) ».", false)
        }
        if let issue = folderIssue { return (issue, true) }
        return ("Vigie le crée s'il n'existe pas, et y range la consigne de l'agent.", false)
    }

    /// Ce qui empêche de lancer côté dossier, avec les règles du moteur (qui vérifie encore) ; nil : rien.
    private var folderIssue: String? { AgentFolderRule.issue(folder, parent: agent.parentFolder) }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Choisir"
        panel.message = "Choisis le dossier du projet, ou crée-le avec « Nouveau dossier »."
        // s'ouvre là où ira le projet : le dossier s'il existe déjà, sinon son parent
        let current = AgentFolderRule.expanded(folder.isEmpty ? agent.parentFolder : folder)
        var isFolder: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: current, isDirectory: &isFolder) && isFolder.boolValue
        panel.directoryURL = URL(filePath: exists ? current : (current as NSString).deletingLastPathComponent,
                                 directoryHint: .isDirectory)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        folder = Fmt.shortPath(AgentFolderRule.expanded(url.path(percentEncoded: false)))
        folderEdited = folder != suggested
        launchIssue = nil
    }

    // MARK: Lancement

    private var missing: [AgentField] {
        agent.fields.filter { $0.required && Self.clean(values[$0.id], kind: $0.kind).isEmpty }
    }

    private var canLaunch: Bool { missing.isEmpty && folderIssue == nil }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 12) {
            notes
            if let launchIssue { issueView(launchIssue) }
            HStack(spacing: 12) {
                if !missing.isEmpty {
                    Text("À remplir : " + missing.map(\.label).formatted(.list(type: .and).locale(Fmt.locale)))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer()
                Button(prepared ? "Fermer" : "Annuler") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .glassButton()
                AsyncButton("Lancer dans VS Code", systemImage: "arrow.up.forward.app") { await launch() }
                    .keyboardShortcut(.defaultAction)
                    .glassButton(.primary)
                    .disabled(!canLaunch)
                    .help("Vigie prépare le dossier, ouvre VS Code, puis Claude Code avec le message à envoyer")
            }
            .controlSize(.large)
        }
    }

    /// Le compte sur lequel partira la conversation, et les MCP à régler avant (l'agent s'arrêterait en route).
    @ViewBuilder
    private var notes: some View {
        let account = store.agentsState?.account?.displayName
        let toFix = agent.mcpToFix
        if account != nil || !toFix.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                if let account {
                    Label("Partira sur le compte \(account) (celui des nouvelles conversations).", systemImage: Icon.account)
                        .foregroundStyle(.secondary)
                }
                if !toFix.isEmpty {
                    let list = toFix.map { "\($0.name) (\(MCPStatusStyle.label($0.mcpStatus)))" }
                        .formatted(.list(type: .and).locale(Fmt.locale))
                    Label("À régler d'abord sur la page MCP : \(list).", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(Theme.warn)
                }
            }
            .font(.callout)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Le lancement n'a pas abouti : pourquoi, en rouge, juste au-dessus des boutons (le toast de la fenêtre serait
    /// caché derrière la feuille). VS Code fermé : le dossier est prêt, le message se copie d'ici.
    @ViewBuilder
    private func issueView(_ issue: AgentLaunchOutcome) -> some View {
        switch issue {
        case .refused(let text):
            issueLabel(text)
        case .notOpened(let prompt):
            HStack(spacing: 12) {
                issueLabel(AgentLaunch.notOpenedMessage)
                Button(copied ? "Message copié" : "Copier le message", systemImage: copied ? "checkmark" : "doc.on.doc") {
                    SystemActions.copy(prompt)
                    copied = true
                }
                .glassButton()
                .help("Copie le message à envoyer dans Claude Code pour lancer l'agent")
            }
        case .opened:
            EmptyView()
        }
    }

    private func issueLabel(_ text: String) -> some View {
        Label(text, systemImage: "exclamationmark.triangle.fill")
            .font(.callout)
            .foregroundStyle(Theme.alert)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func launch() async {
        guard canLaunch else { return }
        var sent: [String: String] = [:]
        for field in agent.fields {
            let value = Self.clean(values[field.id], kind: field.kind)
            if !value.isEmpty { sent[field.id] = value }
        }
        let outcome = await store.launchAgent(agent, values: sent, folder: AgentFolderRule.expanded(folder))
        switch outcome {
        case .opened:
            dismiss()
        case .refused:
            launchIssue = outcome
        case .notOpened:
            launchIssue = outcome
            prepared = true
            copied = false
        }
    }

    /// Valeur envoyée : sans blancs autour ; une adresse par ligne, sans lignes vides.
    private static func clean(_ value: String?, kind: AgentField.Kind) -> String {
        let text = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard kind == .urls else { return text }
        return text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
    }
}

/// Titre d'un champ, avec « obligatoire » en discret.
private struct FieldTitle: View {
    let text: String
    let required: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(text)
                .fontWeight(.medium)
            if required {
                Text("obligatoire")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// Long texte (questionnaire, adresses) : au moins 140 pt de haut, bordé, avec son exemple en gris tant qu'il est vide.
struct AgentTextArea: View {
    @Binding var text: String
    var placeholder: String?

    var body: some View {
        TextEditor(text: $text)
            .scrollContentBackground(.hidden)
            .padding(8)
            .background(.quinary, in: .rect(cornerRadius: 10))
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(.separator, lineWidth: 1)
            }
            .overlay(alignment: .topLeading) {
                if text.isEmpty, let placeholder {
                    Text(placeholder)
                        .foregroundStyle(.tertiary)
                        .padding(13)
                        .allowsHitTesting(false)
                }
            }
            .frame(minHeight: 140)
    }
}
