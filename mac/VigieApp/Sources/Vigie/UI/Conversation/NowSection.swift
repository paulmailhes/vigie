import SwiftUI

/// Feuille de route : le document d'état que la conversation tient à jour, section par section.
/// Ce qui dit où on en est, la suite et ce qui t'attend est déplié ; le reste se déplie au clic.
struct RoadmapView: View {
    @Environment(VigieStore.self) private var store
    let doc: TrackingDoc
    let cwd: String?
    /// Dans le détail : tout replié, on déplie ce qu'on veut lire.
    var collapsed = false

    private static let open = /(où on en est|ou on en est|prochaine|suite|attend|ordre|en cours|next|todo|à faire|a faire|status|état)/.ignoresCase()

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let intro = doc.intro, !intro.isEmpty {
                markdown(intro)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(doc.sections.enumerated()), id: \.offset) { _, section in
                RoadmapSection(section: section, expandedAtFirst: !collapsed && section.title.contains(Self.open))
            }
            HStack(spacing: 10) {
                Button("Ouvrir \(relative(doc.path)) dans VS Code", systemImage: "doc.text") { SystemActions.openInVSCode(path: doc.path) }
                    .buttonStyle(.link)
                    .help(Fmt.shortPath(doc.path))
                if !doc.others.isEmpty {
                    Text("Aussi : " + doc.others.map { relative($0.path) }.joined(separator: ", "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .font(.callout)
        }
    }

    private func relative(_ path: String) -> String {
        guard let cwd, path.hasPrefix(cwd + "/") else { return (path as NSString).lastPathComponent }
        return String(path.dropFirst(cwd.count + 1))
    }
}

struct RoadmapSection: View {
    let section: TrackingDoc.Section
    let expandedAtFirst: Bool

    @State private var expanded: Bool?

    var body: some View {
        let isOpen = expanded ?? expandedAtFirst
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.smooth) { expanded = !isOpen }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                        .foregroundStyle(.secondary)
                    Text(section.title)
                        .textRole(.item)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            if isOpen, let text = section.text {
                markdown(text)
                    .font(.callout)
                    .padding(.leading, 18)
            }
        }
    }
}

/// Texte Markdown d'un document (gras, code, liens), retours à la ligne gardés. Ce texte vient d'un agent : seuls
/// les liens web (http, https) s'ouvrent ; un lien vers un fichier ou un partage du Mac (file:, smb:…) reste inerte.
@MainActor
func markdown(_ text: String) -> some View {
    var attributed = (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
        ?? AttributedString(text)
    for run in attributed.runs {
        if let link = run.link, !["http", "https"].contains(link.scheme?.lowercased() ?? "") {
            attributed[run.range].link = nil
        }
    }
    return Text(attributed)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
}
