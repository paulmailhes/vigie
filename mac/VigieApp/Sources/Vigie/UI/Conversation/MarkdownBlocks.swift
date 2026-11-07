import SwiftUI

/// Un message de Claude mis en forme bloc par bloc : titres, listes, citations, blocs de code, paragraphes.
/// (Text seul n'affiche pas les blocs Markdown : il colle tout.) Le texte vient de Claude : seuls les liens web
/// s'ouvrent.
struct MarkdownBlocks: View {
    let text: String

    enum Block: Equatable {
        case heading(String, level: Int)
        case bullet(String, depth: Int)
        case numbered(String, number: String)
        case quote(String)
        case code(String)
        case paragraph(String)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(Self.blocks(text).enumerated()), id: \.offset) { _, block in
                view(block)
            }
        }
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func view(_ block: Block) -> some View {
        switch block {
        case .heading(let text, let level):
            markdown(text)
                .font(level <= 1 ? .title3.bold() : level == 2 ? .headline : .subheadline.bold())
                .padding(.top, 4)
        case .bullet(let text, let depth):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(depth == 0 ? "•" : "◦").foregroundStyle(.secondary)
                markdown(text)
            }
            .padding(.leading, CGFloat(depth) * 14)
        case .numbered(let text, let number):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(number).foregroundStyle(.secondary).monospacedDigit()
                markdown(text)
            }
        case .quote(let text):
            markdown(text)
                .foregroundStyle(.secondary)
                .padding(.leading, 10)
                .overlay(alignment: .leading) {
                    Rectangle().fill(.quaternary).frame(width: 3)
                }
        case .code(let text):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.callout.monospaced())
                    .fixedSize()
            }
            .padding(8)
            .background(.quinary, in: .rect(cornerRadius: Theme.cornerInner))
        case .paragraph(let text):
            markdown(text)
        }
    }

    /// Découpe en blocs : une ligne de liste ou de titre est un bloc ; les lignes de texte qui se suivent forment un
    /// paragraphe ; un bloc de code va de ``` à ```. Pur : appelable hors de l'acteur principal (essais).
    nonisolated static func blocks(_ text: String) -> [Block] {
        var out: [Block] = []
        var paragraph: [String] = []
        var code: [String]?
        func flush() {
            if !paragraph.isEmpty { out.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
        }
        for raw in text.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") || line.hasPrefix("~~~") {
                if let lines = code {
                    out.append(.code(lines.joined(separator: "\n")))
                    code = nil
                } else {
                    flush()
                    code = []
                }
                continue
            }
            if code != nil { code?.append(raw); continue }
            if line.isEmpty { flush(); continue }
            if let match = line.firstMatch(of: /^(#{1,6})\s+(.+)$/) {
                flush(); out.append(.heading(String(match.2), level: match.1.count)); continue
            }
            if let match = raw.firstMatch(of: /^(\s*)[-*+]\s+(?:\[[ xX]\]\s+)?(.+)$/) {
                flush(); out.append(.bullet(String(match.2), depth: min(2, match.1.count / 2))); continue
            }
            if let match = line.firstMatch(of: /^(\d{1,3}[.)])\s+(.+)$/) {
                flush(); out.append(.numbered(String(match.2), number: String(match.1))); continue
            }
            if let match = line.firstMatch(of: /^>\s?(.*)$/) {
                flush(); out.append(.quote(String(match.1))); continue
            }
            if line.firstMatch(of: /^\|?\s*:?-{3,}/) != nil { continue } // séparateur de tableau
            paragraph.append(line)
        }
        if let lines = code { out.append(.code(lines.joined(separator: "\n"))) }
        flush()
        return out
    }
}
