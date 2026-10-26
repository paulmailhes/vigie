import AppKit
import SwiftUI

/// Une icône par TYPE, la même partout (vue d'ensemble, conversation, MCP, barre des menus).
enum Icon {
    static let artifact = "doc.richtext"
    static let file = "doc"
    static let command = "terminal"
    static let commit = "smallcircle.filled.circle"
    static let push = "arrow.up.circle"
    static let agent = "person.2"
    /// Un agent de la page Agents (recette à lancer), à ne pas confondre avec les assistants d'une conversation.
    static let recipe = "wand.and.stars"
    /// Une bibliothèque d'agents (un dépôt git, un dossier par agent).
    static let library = "books.vertical"
    static let workflow = "point.3.connected.trianglepath.dotted"
    static let test = "checkmark.seal"
    static let testFailed = "xmark.octagon"
    static let testExpectedFail = "flask"
    static let question = "questionmark.bubble"
    static let guardRule = "hand.raised.fill"
    static let web = "globe"
    static let mcp = "puzzlepiece.extension"
    static let accepted = "checkmark.circle"
    static let limit = "gauge.with.dots.needle.100percent"
    static let waiting = "person.crop.circle.badge.clock"
    static let mission = "flag.checkered"
    static let other = "ellipsis.circle"
    static let account = "person.crop.circle"
    static let week = "chart.pie"
    static let runaway = "flame"
    static let usage = "chart.xyaxis.line"
}

/// Une icône par SERVICE : logo Simple Icons (CC0) en teinte neutre, sinon un SF Symbol.
@MainActor
enum ServiceIcon {
    private struct Entry {
        let needles: [String]
        let logo: String?
        let symbol: String
    }

    /// Ordre important : le premier qui correspond gagne (« google-calendar » avant « calendar »).
    private static let table: [Entry] = [
        Entry(needles: ["figma"], logo: "figma", symbol: "paintpalette"),
        Entry(needles: ["webflow"], logo: "webflow", symbol: "globe"),
        Entry(needles: ["notion"], logo: "notion", symbol: "doc.text"),
        Entry(needles: ["supabase"], logo: "supabase", symbol: "cylinder.split.1x2"),
        Entry(needles: ["netlify"], logo: "netlify", symbol: "server.rack"),
        Entry(needles: ["vercel"], logo: "vercel", symbol: "triangle"),
        Entry(needles: ["resend"], logo: "resend", symbol: "paperplane"),
        Entry(needles: ["n8n"], logo: "n8n", symbol: "point.3.filled.connected.trianglepath.dotted"),
        Entry(needles: ["obsidian"], logo: "obsidian", symbol: "book.closed"),
        Entry(needles: ["github"], logo: "github", symbol: "chevron.left.forwardslash.chevron.right"),
        Entry(needles: ["gmail"], logo: "gmail", symbol: "envelope"),
        Entry(needles: ["google-drive", "google drive", "google_drive", "gdrive"], logo: "googledrive", symbol: "externaldrive"),
        Entry(needles: ["google-calendar", "google calendar", "google_calendar"], logo: "googlecalendar", symbol: "calendar"),
        Entry(needles: ["google-sheets", "google sheets", "google_sheets"], logo: "googlesheets", symbol: "tablecells"),
        Entry(needles: ["claude-docs", "claude docs", "claude_docs"], logo: "claude", symbol: "doc.text"),
        Entry(needles: ["stripe"], logo: "stripe", symbol: "creditcard"),
        Entry(needles: ["semrush"], logo: "semrush", symbol: "magnifyingglass"),
        Entry(needles: ["vimeo"], logo: "vimeo", symbol: "play.rectangle"),
        Entry(needles: ["paddle"], logo: "paddle", symbol: "creditcard"),
        Entry(needles: ["slack"], logo: nil, symbol: "number"),
        Entry(needles: ["qonto"], logo: nil, symbol: "eurosign.circle"),
        Entry(needles: ["gocardless"], logo: nil, symbol: "banknote"),
        Entry(needles: ["pennylane"], logo: nil, symbol: "chart.bar.doc.horizontal"),
        Entry(needles: ["metricool"], logo: nil, symbol: "chart.line.uptrend.xyaxis"),
        Entry(needles: ["pipedrive"], logo: nil, symbol: "person.crop.rectangle.stack"),
        Entry(needles: ["artlist"], logo: nil, symbol: "music.note"),
        Entry(needles: ["anarlog"], logo: nil, symbol: "waveform"),
        Entry(needles: ["magnific"], logo: nil, symbol: "wand.and.sparkles"),
        Entry(needles: ["fusion"], logo: nil, symbol: "atom"),
        Entry(needles: ["postgres"], logo: nil, symbol: "cylinder"),
        Entry(needles: ["drive"], logo: "googledrive", symbol: "externaldrive"),
        Entry(needles: ["calendar"], logo: "googlecalendar", symbol: "calendar"),
        Entry(needles: ["sheets"], logo: "googlesheets", symbol: "tablecells"),
    ]

    private static var cache: [String: NSImage] = [:]

    private static func entry(service: String?, name: String) -> Entry? {
        let keys = [service, name].compactMap { $0?.lowercased() }.filter { !$0.isEmpty && $0 != "autre" }
        for key in keys {
            if let found = table.first(where: { entry in entry.needles.contains { key.contains($0) } }) {
                return found
            }
        }
        return nil
    }

    /// Le SF Symbol du service (repli quand aucun logo n'est embarqué).
    static func symbol(service: String?, name: String) -> String {
        entry(service: service, name: name)?.symbol ?? Icon.mcp
    }

    /// Le logo monochrome du service, s'il est embarqué.
    static func logo(service: String?, name: String) -> NSImage? {
        guard let slug = entry(service: service, name: name)?.logo else { return nil }
        if let image = cache[slug] { return image }
        guard let svg = ServiceLogos.svg[slug], let image = NSImage(data: Data(svg.utf8)) else { return nil }
        image.isTemplate = true
        cache[slug] = image
        return image
    }

    /// Un service cité dans un texte (« mcp__figma-perso__get_screenshot »), pour l'icône d'une validation MCP.
    static func guess(in text: String?) -> String? {
        guard let text = text?.lowercased(), !text.isEmpty else { return nil }
        return entry(service: nil, name: text) != nil ? text : nil
    }
}

/// Icône d'un service, alignée sur la colonne des icônes de rangée.
struct ServiceGlyph: View {
    let service: String?
    let name: String
    var size: CGFloat = 15

    var body: some View {
        Group {
            if let image = ServiceIcon.logo(service: service, name: name) {
                Image(nsImage: image)
                    .renderingMode(.template)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    .frame(width: size - 1, height: size - 1)
            } else {
                Image(systemName: ServiceIcon.symbol(service: service, name: name))
                    .symbolRenderingMode(.hierarchical)
                    .font(.system(size: size))
            }
        }
        .foregroundStyle(.secondary)
        .frame(width: 22)
        .accessibilityHidden(true)
    }
}

/// Icône d'une action validée : le logo du service pour un MCP, sinon l'icône du type.
struct ActionIcon: View {
    let kind: ItemKind
    var service: String?
    var hint: String?
    var alert = false

    var body: some View {
        if kind == .mcp, !alert, let key = service ?? ServiceIcon.guess(in: hint) {
            ServiceGlyph(service: key, name: key)
        } else {
            RowIcon(symbol: Theme.symbol(for: kind), alert: alert)
        }
    }
}
