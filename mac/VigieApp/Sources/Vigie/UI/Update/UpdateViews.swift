import SwiftUI

/// Bandeau de la vue d'ensemble : une nouvelle version, une installation en cours, ou une installation ratée.
struct UpdateBanner: View {
    @Environment(VigieStore.self) private var store

    var body: some View {
        if let update = store.updateStatus, update.installing == true || update.available == true || update.lastError != nil {
            HStack(spacing: 12) {
                Image(systemName: update.lastError != nil && update.available == true ? "exclamationmark.arrow.triangle.2.circlepath" : "arrow.down.circle.fill")
                    .font(.title2)
                    .foregroundStyle(update.lastError != nil && update.available == true ? Theme.warn : Color.accentColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title(update)).font(.headline)
                    Text(detail(update))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                if update.installing == true {
                    ProgressView().controlSize(.small)
                } else if update.available == true {
                    if !update.releases.isEmpty {
                        Button("Nouveautés") { store.whatsNew = update.releases }
                            .glassButton()
                    }
                    AsyncButton("Mettre à jour") { await store.installUpdate() }
                        .glassButton(.primary)
                }
            }
            .padding(12)
            .background(.quinary, in: .rect(cornerRadius: Theme.corner))
        }
    }

    private func title(_ update: UpdateStatus) -> String {
        if update.installing == true { return "Mise à jour en cours…" }
        if let latest = update.latest, update.available == true { return "Vigie \(latest) est disponible" }
        return "Mise à jour"
    }

    private func detail(_ update: UpdateStatus) -> String {
        if update.installing == true { return "Vigie redémarre tout seul dans un instant ; tes réglages sont gardés." }
        if let error = update.lastError, update.available == true { return "\(error) Réessaie dans un moment ; si ça ne passe toujours pas, télécharge Vigie à nouveau." }
        return "Un clic : Vigie se met à jour tout seul. Tes réglages et tes comptes sont gardés."
    }
}

/// « Quoi de neuf » : au premier lancement après une mise à jour, les notes des versions arrivées.
struct WhatsNewSheet: View {
    @Environment(VigieStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let releases: [ReleaseNote]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                SheetIcon(symbol: "sparkles")
                VStack(alignment: .leading, spacing: 2) {
                    Text("Quoi de neuf dans Vigie").font(.title3.bold())
                    if let current = store.updateStatus?.current {
                        Text("Version \(current)").foregroundStyle(.secondary)
                    }
                }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    ForEach(releases) { release in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(release.name ?? "Vigie \(release.version)").font(.headline)
                            Text(Self.render(release.notes ?? ""))
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                Spacer()
                Button("C'est noté") { dismiss() }
                    .keyboardShortcut(.defaultAction)
                    .glassButton(.primary)
            }
        }
        .padding(24)
        .frame(width: 560, height: 480)
    }

    /// Les notes de version (Markdown simple), sans le bloc « Installer ou mettre à jour » destiné à GitHub.
    static func render(_ notes: String) -> AttributedString {
        var lines: [String] = []
        for line in notes.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("Installer ou mettre à jour") || trimmed.hasPrefix("Mettre à jour :") { break }
            lines.append(trimmed.hasPrefix("- ") ? "• " + trimmed.dropFirst(2) : line)
        }
        let text = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

/// Réglages › Mises à jour.
struct UpdateSettingsView: View {
    @Environment(VigieStore.self) private var store

    var body: some View {
        @Bindable var store = store
        Form {
            Section {
                Toggle(isOn: $store.autoUpdate) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Mises à jour automatiques")
                        Text("Vigie installe tout seul ses nouvelles versions, jamais pendant qu'une action attend ta décision.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
                LabeledContent("Version installée") {
                    if let update = store.updateStatus, update.available != true, let checked = update.checkedAt {
                        Text("\(update.current ?? "…") · à jour, vérifié \(Fmt.ago(checked, now: store.now))")
                    } else {
                        Text(store.updateStatus?.current ?? "…")
                    }
                }
                if let update = store.updateStatus, update.available == true, let latest = update.latest {
                    LabeledContent("Disponible", value: latest)
                }
                HStack {
                    AsyncButton("Vérifier maintenant") { await store.checkUpdate() }
                    if store.updateStatus?.available == true {
                        AsyncButton("Mettre à jour") { await store.installUpdate() }
                            .disabled(store.updateStatus?.installing == true)
                    }
                    if let releases = store.updateStatus?.releases, !releases.isEmpty {
                        Button("Nouveautés") { store.whatsNew = releases }
                    }
                }
            }
        }
        .pageForm()
        .task { await store.refreshUpdate() }
    }
}
