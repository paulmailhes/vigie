import AppKit
import SwiftUI

/// Lancer un agent, dans l'ordre : le dossier du projet (le moteur dit s'il existe, ce qu'il y a dans sources/, et
/// s'il y a déjà une conversation à continuer), ce que tu as sur le projet (texte et fichiers glissés), ce que l'agent
/// va créer, puis où l'ouvrir. Le moteur prépare le dossier et ouvre VS Code ou l'app Claude ; il refuse (dossier
/// refusé, fichier introuvable…) : la feuille reste ouverte, le message s'affiche en bas, au-dessus des boutons.
struct AgentLaunchSheet: View {
    @Environment(VigieStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let agent: AgentInfo

    @State private var values: [String: String] = [:]
    @State private var folder: String
    /// Le dossier a été changé à la main : il ne suit plus le nom saisi.
    @State private var folderEdited: Bool
    /// Ce que le moteur a dit du dossier, et pour quel chemin (un autre chemin tapé depuis : on n'en montre rien).
    @State private var checked: (path: String, info: AgentFolderInfo)?
    /// La première lecture part tout de suite ; les suivantes, 400 ms après la dernière frappe.
    @State private var checkedOnce = false
    /// La conversation à continuer (la plus récente par défaut), ou une nouvelle.
    @State private var pick: String?
    @State private var startNew = false
    @State private var attachments: AgentAttachments
    /// Un fichier pas joint (trop de fichiers, pièce jointe illisible) : effacé au prochain ajout ou retrait.
    @State private var filesIssue: String?
    @State private var box = AgentDropBox()
    /// Choisi dans la feuille ; sinon le dernier utilisé (moteur).
    @State private var surface: AgentSurface?
    @State private var launching = false
    /// Le dernier lancement a été refusé : effacé dès qu'un champ, le dossier ou les fichiers changent.
    @State private var launchIssue: String?
    @FocusState private var focused: Focus?

    private enum Focus: Hashable {
        case field(String)
        case folder
    }

    /// `folder` et `files` : déjà remplis (mode captures).
    init(agent: AgentInfo, folder: String? = nil, files: [AgentAttachment] = []) {
        self.agent = agent
        _folder = State(initialValue: folder ?? Fmt.shortPath(agent.suggestedFolder(values: [:])))
        _folderEdited = State(initialValue: folder != nil)
        _attachments = State(initialValue: AgentAttachments(files))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding([.horizontal, .top], 24)
                .padding(.bottom, 14)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    projectView
                    if let info, !info.resumable.isEmpty { conversationView(info.resumable) }
                    ForEach(otherFields) { field in
                        fieldView(field)
                        if field.id == agent.dropField?.id { attachmentsView }
                    }
                    if agent.dropField == nil { attachmentsView }
                    if !agent.willCreate.isEmpty { createsView }
                }
                .padding(24)
            }
            Divider()
            footer
                .padding(.horizontal, 24)
                .padding(.vertical, 16)
        }
        .frame(width: 640)
        .frame(minHeight: 380, idealHeight: idealHeight)
        .interactiveDismissDisabled(launching)
        .onAppear(perform: focusFirst)
        .onDisappear { box.clear() }
        .task(id: folderToCheck) { await check(folderToCheck) }
    }

    /// Assez haut pour tout voir quand c'est court ; au-delà, le formulaire défile.
    private var idealHeight: CGFloat {
        let single = agent.fields.count == 1
        var height: CGFloat = agent.namingField == nil ? 330 : 412
        for field in otherFields { height += field.kind.isMultiline ? (single ? 300 : 215) : 82 }
        height += 44 + CGFloat(attachments.items.count) * 26
        if let info, !info.resumable.isEmpty { height += 130 }
        if !agent.willCreate.isEmpty { height += 34 + CGFloat(agent.willCreate.count) * 22 }
        if agent.libraryName != nil { height += 20 }
        return min(780, height)
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
                if let library = agent.libraryName {
                    Label("De la bibliothèque \(library)", systemImage: Icon.library)
                        .labelStyle(CompactLabelStyle())
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.top, 2)
                }
            }
        }
    }

    // MARK: Projet

    /// Le champ qui nomme le dossier ; sans lui, le dossier, curseur à la fin (« ~/Code/| ») : le nom du projet s'y tape
    /// sans effacer le début, que macOS sélectionne en entier. Déjà rempli (captures) : rien.
    private func focusFirst() {
        guard !folderEdited else { return }
        if let naming = agent.namingField {
            focused = .field(naming.id)
            return
        }
        focused = .folder
        let start = folder
        Task { @MainActor in
            for _ in 0..<20 {
                try? await Task.sleep(for: .milliseconds(50))
                guard let editor = NSApp.keyWindow?.firstResponder as? NSTextView, editor.isFieldEditor,
                      editor.string == start else { continue }
                editor.setSelectedRange(NSRange(location: (editor.string as NSString).length, length: 0))
                return
            }
        }
    }

    /// Le champ qui nomme le dossier (s'il y en a un), puis le dossier lui-même.
    private var projectView: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let naming = agent.namingField { fieldView(naming) }
            folderView
        }
    }

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
            Text("Dossier du projet")
                .fontWeight(.medium)
            HStack(spacing: 8) {
                TextField("Dossier du projet", text: folderBinding, prompt: Text(Fmt.shortPath(agent.parentFolder) + "/cabinet-martin"))
                    .textFieldStyle(.roundedBorder)
                    .labelsHidden()
                    .focused($focused, equals: .folder)
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

    /// La légende du dossier : d'où vient son nom, ce qui ne va pas, puis ce qu'en dit le moteur.
    private var folderNote: (text: String, warn: Bool) {
        if !folderEdited, let naming = agent.namingField, Self.clean(values[naming.id], kind: .text).isEmpty {
            return ("Son nom vient de « \(naming.label) ».", false)
        }
        if agent.namingField == nil, AgentFolderRule.expanded(folder) == AgentFolderRule.expanded(agent.parentFolder) {
            return ("Termine par le nom du projet, par exemple \(Fmt.shortPath(agent.parentFolder))/cabinet-martin.", false)
        }
        if let issue = folderIssue { return (issue, true) }
        if let info { return info.note }
        return ("Vigie le crée s'il n'existe pas.", false)
    }

    /// Ce qui empêche de lancer côté dossier, avec les règles du moteur (qui vérifie encore) ; nil : rien.
    private var folderIssue: String? { AgentFolderRule.issue(folder, parent: agent.parentFolder) }

    /// Le dossier à faire lire au moteur : seulement un dossier que la feuille accepte déjà.
    private var folderToCheck: String? { folderIssue == nil ? AgentFolderRule.expanded(folder) : nil }

    /// Ce que le moteur a dit du dossier affiché ; nil : pas encore lu, ou moteur plus ancien (pas de lecture).
    private var info: AgentFolderInfo? {
        guard let checked, checked.path == folderToCheck else { return nil }
        return checked.info
    }

    /// Lit le dossier auprès du moteur ; annulée (`.task(id:)`) dès que le dossier change encore ou que la feuille se
    /// ferme. La conversation proposée repart de la plus récente.
    private func check(_ path: String?) async {
        let pause = checkedOnce ? AgentFolderCheck.pause : .zero
        checkedOnce = true
        guard let path else { return }
        guard let found = await AgentFolderCheck.afterPause(pause, read: { await store.agentFolder(path) }),
              !Task.isCancelled else { return }
        checked = (path, found)
        pick = found.resumable.first?.id
        startNew = false
    }

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

    // MARK: Conversation existante

    /// Continuer la plus récente (par défaut), une autre du dossier, ou en commencer une nouvelle.
    private func conversationView(_ list: [AgentConversation]) -> some View {
        let shown = list.first { $0.id == pick } ?? list[0]
        return VStack(alignment: .leading, spacing: 8) {
            Label(list.count > 1 ? "\(list.count) conversations existent déjà dans ce dossier" : "Une conversation existe déjà dans ce dossier",
                  systemImage: "bubble.left.and.text.bubble.right")
                .fontWeight(.medium)
            if list.count > 1 {
                Picker("Conversation à continuer", selection: Binding { shown.id } set: { pick = $0 }) {
                    ForEach(list) { Text($0.summary(now: store.now)).tag($0.id) }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .fixedSize()
                .disabled(startNew)
            } else {
                Text(shown.summary(now: store.now))
                    .foregroundStyle(.secondary)
            }
            Picker("Conversation", selection: $startNew) {
                Text("Continuer cette conversation").tag(false)
                Text("Nouvelle conversation").tag(true)
            }
            .pickerStyle(.radioGroup)
            .horizontalRadioGroupLayout()
            .labelsHidden()
            Text(startNew ? "L'agent part de zéro, dans le même dossier." : "L'agent garde son historique et y ajoute ce qu'il doit créer.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quinary, in: .rect(cornerRadius: Theme.corner))
    }

    private var session: String? { AgentLaunch.session(info, pick: pick, startNew: startNew) }

    // MARK: Champs

    /// Les champs sous le dossier (celui qui le nomme est déjà au-dessus).
    private var otherFields: [AgentField] {
        agent.fields.filter { $0.id != agent.namingField?.id }
    }

    private func fieldView(_ field: AgentField) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            FieldTitle(text: field.label, required: field.required)
            if field.kind.isMultiline {
                let drop = field.id == agent.dropField?.id
                AgentTextArea(text: binding(field), placeholder: placeholder(field, drop: drop), label: field.label,
                              minHeight: agent.fields.count == 1 ? 220 : 140,
                              onFiles: drop ? { receive($0) } : nil)
            } else {
                TextField(field.label, text: binding(field), prompt: Text(field.placeholder ?? (field.kind == .url ? "https://…" : "")))
                    .textFieldStyle(.roundedBorder)
                    .labelsHidden()
                    .focused($focused, equals: .field(field.id))
            }
            if let caption = caption(field) {
                Text(caption)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func placeholder(_ field: AgentField, drop: Bool) -> String? {
        if let placeholder = field.placeholder { return placeholder }
        if field.kind == .urls { return "https://…" }
        return drop ? "Colle ici ce que tu as : questionnaire, e-mail du client, liens, notes…" : nil
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

    // MARK: Fichiers joints

    /// Les fichiers joints (nom, taille, retirer), « Ajouter des fichiers… » et où ils iront.
    private var attachmentsView: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !attachments.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(attachments.items) { attachmentRow($0) }
                }
            }
            HStack(spacing: 10) {
                Button("Ajouter des fichiers…", systemImage: "paperclip", action: chooseFiles)
                    .glassButton()
                    .help("Des fichiers ou des dossiers : PDF, Word, brandbook, images…")
                Text(box.copying > 0 ? "Copie des fichiers en cours…"
                     : attachments.isEmpty && agent.dropField != nil
                     ? "Ou glisse-les dans le champ. Ils seront copiés dans sources/ du projet."
                     : "Ils seront copiés dans sources/ du projet.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let issue = legacyFilesIssue ?? filesIssue {
                Text(issue)
                    .font(.caption)
                    .foregroundStyle(Theme.warn)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func attachmentRow(_ item: AgentAttachment) -> some View {
        HStack(spacing: 8) {
            Image(systemName: item.isFolder ? "folder" : "doc")
                .foregroundStyle(.secondary)
                .frame(width: 16)
                .accessibilityHidden(true)
            Text(item.name)
                .lineLimit(1)
                .truncationMode(.middle)
            Text(item.detail)
                .foregroundStyle(.secondary)
                .monospacedDigit()
                .fixedSize()
            Spacer(minLength: 8)
            Button {
                remove(item)
            } label: {
                Image(systemName: "xmark.circle.fill")
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.secondary)
            .disabled(launching)
            .help("Retirer ce fichier (il reste là où il est)")
            .accessibilityLabel("Retirer \(item.name)")
        }
        .font(.callout)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(.quinary, in: .rect(cornerRadius: 8))
    }

    /// Un moteur plus ancien ne copie pas les fichiers joints : rien ne part tant qu'il y en a.
    private var legacyFilesIssue: String? {
        store.agentsState?.surfaces == nil && !attachments.isEmpty ? AgentLaunch.legacyFilesMessage : nil
    }

    /// Glissés dans le champ (Finder, Mail, Safari).
    private func receive(_ pasteboard: NSPasteboard) {
        box.receive(pasteboard) { items, issue in add(items, issue: issue) }
    }

    private func chooseFiles() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.prompt = "Joindre"
        panel.message = "Choisis les fichiers ou les dossiers à joindre : ils seront copiés dans sources/ du projet."
        guard panel.runModal() == .OK else { return }
        let urls = panel.urls
        Task {
            let (items, issue) = await box.attach(urls)
            add(items, issue: issue)
        }
    }

    private func add(_ items: [AgentAttachment], issue: String?) {
        filesIssue = attachments.add(items) ?? issue
        launchIssue = nil
    }

    private func remove(_ item: AgentAttachment) {
        if let removed = attachments.remove(item.id) { box.discard(removed) }
        filesIssue = nil
        launchIssue = nil
    }

    // MARK: Ce que l'agent va créer

    private var createsView: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Ce que l'agent va créer")
                .fontWeight(.medium)
            ForEach(Array(agent.willCreate.enumerated()), id: \.offset) { _, line in
                Label(line, systemImage: "checkmark")
                    .labelStyle(CompactLabelStyle())
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(.callout)
    }

    // MARK: Lancement

    private var surfaces: AgentSurfaces? { store.agentsState?.surfaces }

    /// Où s'ouvrira l'agent : le choix de la feuille s'il est encore possible, sinon celui du moteur ; nil : moteur
    /// plus ancien, ou rien d'installé.
    private var chosenSurface: AgentSurface? {
        guard let surfaces else { return nil }
        if let surface, surfaces.available.contains(surface) { return surface }
        return surfaces.preferred
    }

    /// Ni VS Code ni l'app Claude : rien pour ouvrir l'agent.
    private var surfaceIssue: String? {
        guard let surfaces, surfaces.available.isEmpty else { return nil }
        return AgentLaunch.noSurfaceMessage
    }

    private var missing: [AgentField] {
        agent.fields.filter { $0.required && Self.clean(values[$0.id], kind: $0.kind).isEmpty }
    }

    private var canLaunch: Bool {
        !launching && missing.isEmpty && folderIssue == nil && info?.problem == nil && surfaceIssue == nil
            && legacyFilesIssue == nil && box.copying == 0
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 12) {
            notes
            if let launchIssue {
                Label(launchIssue, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(Theme.alert)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 12) {
                surfaceChoice
                Spacer()
                Button("Annuler") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .glassButton()
                    .disabled(launching)
                launchButton
            }
            .controlSize(.large)
        }
    }

    /// VS Code ou l'app Claude : un choix s'il y a les deux, une simple phrase s'il n'y en a qu'un.
    @ViewBuilder
    private var surfaceChoice: some View {
        let available = surfaces?.available ?? []
        if available.count > 1 {
            Picker("Ouvrir dans", selection: Binding { chosenSurface ?? available[0] } set: { surface = $0 }) {
                ForEach(available) { Text($0.choice).tag($0) }
            }
            .pickerStyle(.segmented)
            .fixedSize()
            .disabled(launching)
        } else if let only = available.first {
            Text("S'ouvre dans \(only.label)")
                .foregroundStyle(.secondary)
        }
    }

    /// Pendant l'attente (le moteur attend que la fenêtre du projet soit prête, 30 s au plus) : « Ouverture… ».
    private var launchButton: some View {
        Button {
            Task { await launch() }
        } label: {
            if launching {
                HStack(spacing: 6) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Ouverture…")
                }
            } else {
                Label(AgentLaunch.buttonTitle(surface: chosenSurface, continuing: session != nil), systemImage: "arrow.up.forward.app")
            }
        }
        .keyboardShortcut(.defaultAction)
        .glassButton(.primary)
        .disabled(!canLaunch)
        .help("Vigie prépare le dossier et y copie les fichiers joints, puis ouvre \(chosenSurface?.label ?? "la conversation") avec le message à envoyer")
    }

    /// Le compte sur lequel partira la conversation, les MCP à régler avant (l'agent s'arrêterait en route), ce qui
    /// reste à remplir.
    @ViewBuilder
    private var notes: some View {
        let account = store.agentsState?.account?.displayName
        let toFix = agent.mcpToFix
        if account != nil || !toFix.isEmpty || !missing.isEmpty || surfaceIssue != nil {
            VStack(alignment: .leading, spacing: 4) {
                // l'app Claude a son propre compte : celui de Vigie ne vaut que pour VS Code
                if chosenSurface == .claudeApp {
                    Label("Partira sur le compte connecté dans l'app Claude.", systemImage: Icon.account)
                        .foregroundStyle(.secondary)
                } else if let account {
                    Label("Partira sur le compte \(account) (celui des nouvelles conversations).", systemImage: Icon.account)
                        .foregroundStyle(.secondary)
                }
                if !toFix.isEmpty {
                    let list = toFix.map { "\($0.name) (\(MCPStatusStyle.label($0.mcpStatus)))" }
                        .formatted(.list(type: .and).locale(Fmt.locale))
                    Label("À régler d'abord sur la page MCP : \(list).", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(Theme.warn)
                }
                if let surfaceIssue {
                    Label(surfaceIssue, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(Theme.warn)
                }
                if !missing.isEmpty {
                    Label("À remplir : " + missing.map(\.label).formatted(.list(type: .and).locale(Fmt.locale)) + ".",
                          systemImage: "square.and.pencil")
                        .foregroundStyle(.secondary)
                }
            }
            .font(.callout)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func launch() async {
        guard canLaunch else { return }
        launching = true
        launchIssue = nil
        var sent: [String: String] = [:]
        for field in agent.fields {
            let value = Self.clean(values[field.id], kind: field.kind)
            if !value.isEmpty { sent[field.id] = value }
        }
        let outcome = await store.launchAgent(agent, values: sent, folder: AgentFolderRule.expanded(folder),
                                              files: attachments.paths, surface: chosenSurface, session: session)
        launching = false
        switch outcome {
        case .launched: dismiss()
        case .refused(let text): launchIssue = text
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
