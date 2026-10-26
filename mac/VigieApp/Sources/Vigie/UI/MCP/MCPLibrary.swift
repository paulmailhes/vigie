import SwiftUI

/// Bibliothèque de MCP officiels (serveurs distants des éditeurs eux-mêmes, adresses vérifiées le 2026-10-21) :
/// un clic, et Vigie l'ajoute à tous les comptes par sa passerelle, puis ouvre une seule fois la page d'autorisation.
/// Pas de relais tiers : un MCP voit tes données, seuls les serveurs des éditeurs sont proposés ici.
struct MCPLibraryEntry: Identifiable, Hashable {
    let id: String          // nom du MCP une fois ajouté
    let title: String
    let category: String
    let url: String
    var type = "http"
    /// Sans compte à autoriser (documentation publique).
    var open = false
    /// Passe par la passerelle de Vigie (une autorisation pour tous les comptes). Figma n'accepte que certaines
    /// applications (comme Claude Code) : il reste branché compte par compte.
    var viaGateway = true

    /// Services qui refusent la passerelle (inscription d'application refusée, vérifié le 2026-10-21).
    static let gatewayRefused: Set<String> = ["mcp.figma.com"]

    static let all: [MCPLibraryEntry] = [
        .init(id: "notion", title: "Notion", category: "Notes et documents", url: "https://mcp.notion.com/mcp"),
        .init(id: "figma", title: "Figma", category: "Design", url: "https://mcp.figma.com/mcp", viaGateway: false),
        .init(id: "canva", title: "Canva", category: "Design", url: "https://mcp.canva.com/mcp"),
        .init(id: "webflow", title: "Webflow", category: "Sites", url: "https://mcp.webflow.com/mcp"),
        .init(id: "wix", title: "Wix", category: "Sites", url: "https://mcp.wix.com/mcp"),
        .init(id: "github", title: "GitHub", category: "Code", url: "https://api.githubcopilot.com/mcp/"),
        .init(id: "linear", title: "Linear", category: "Projets et tickets", url: "https://mcp.linear.app/mcp"),
        .init(id: "atlassian", title: "Jira et Confluence (Atlassian)", category: "Projets et tickets", url: "https://mcp.atlassian.com/v1/mcp"),
        .init(id: "asana", title: "Asana", category: "Projets et tickets", url: "https://mcp.asana.com/v2/mcp"),
        .init(id: "monday", title: "monday.com", category: "Projets et tickets", url: "https://mcp.monday.com/mcp"),
        .init(id: "clickup", title: "ClickUp", category: "Projets et tickets", url: "https://mcp.clickup.com/mcp"),
        .init(id: "airtable", title: "Airtable", category: "Données", url: "https://mcp.airtable.com/mcp"),
        .init(id: "supabase", title: "Supabase", category: "Données", url: "https://mcp.supabase.com/mcp"),
        .init(id: "neon", title: "Neon", category: "Données", url: "https://mcp.neon.tech/mcp"),
        .init(id: "prisma", title: "Prisma", category: "Données", url: "https://mcp.prisma.io/mcp"),
        .init(id: "vercel", title: "Vercel", category: "Déploiement", url: "https://mcp.vercel.com"),
        .init(id: "cloudflare", title: "Cloudflare", category: "Déploiement", url: "https://mcp.cloudflare.com/mcp"),
        .init(id: "sentry", title: "Sentry", category: "Déploiement", url: "https://mcp.sentry.dev/mcp"),
        .init(id: "hubspot", title: "HubSpot", category: "Clients et ventes", url: "https://mcp.hubspot.com"),
        .init(id: "intercom", title: "Intercom", category: "Clients et ventes", url: "https://mcp.intercom.com/mcp"),
        .init(id: "stripe", title: "Stripe", category: "Paiements", url: "https://mcp.stripe.com"),
        .init(id: "paypal", title: "PayPal", category: "Paiements", url: "https://mcp.paypal.com/mcp"),
        .init(id: "square", title: "Square", category: "Paiements", url: "https://mcp.squareup.com/sse", type: "sse"),
        .init(id: "zapier", title: "Zapier", category: "Automatisation", url: "https://mcp.zapier.com/api/mcp/mcp"),
        .init(id: "context7", title: "Context7 (documentation de code)", category: "Documentation", url: "https://mcp.context7.com/mcp", open: true),
        .init(id: "cloudflare-docs", title: "Documentation Cloudflare", category: "Documentation", url: "https://docs.mcp.cloudflare.com/mcp", open: true),
        .init(id: "huggingface", title: "Hugging Face", category: "Documentation", url: "https://huggingface.co/mcp", open: true),
    ]
}

struct MCPLibrarySheet: View {
    @Environment(VigieStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    @State private var added: Set<String> = []

    private var accounts: [Account] { store.accounts.filter { !$0.isCodex && $0.isConnected } }
    /// Les MCP du Mac qui pointent déjà vers ce serveur (même adresse, quel que soit leur nom).
    private func present(_ entry: MCPLibraryEntry) -> [String] {
        let url = entry.url.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return (store.mcp?.user ?? []).filter {
            $0.name == entry.id || $0.target?.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == url
        }.map(\.name)
    }

    private var entries: [MCPLibraryEntry] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        return MCPLibraryEntry.all.filter { q.isEmpty || $0.title.lowercased().contains(q) || $0.category.lowercased().contains(q) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                SheetIcon(symbol: Icon.mcp)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Bibliothèque de MCP").font(.title3.bold())
                    Text("Les MCP officiels, proposés par les services eux-mêmes. Un clic : il arrive sur tous tes comptes Claude.")
                        .foregroundStyle(.secondary)
                }
            }
            TextField("Chercher (Notion, design, paiements…)", text: $search)
                .textFieldStyle(.roundedBorder)
            List {
                ForEach(Dictionary(grouping: entries, by: \.category).sorted { $0.key < $1.key }, id: \.key) { category, items in
                    Section(category) {
                        ForEach(items) { entry in row(entry) }
                    }
                }
            }
            .listStyle(.inset)
            .frame(minHeight: 300)
            HStack {
                Spacer()
                Button("Fermer") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .glassButton()
            }
        }
        .padding(24)
        .frame(width: 620, height: 640)
        .task { if store.mcp == nil { await store.refreshMCP() } }
    }

    private func row(_ entry: MCPLibraryEntry) -> some View {
        HStack(spacing: 10) {
            ServiceGlyph(service: entry.id, name: entry.title)
            VStack(alignment: .leading, spacing: 1) {
                Text(entry.title)
                Text(entry.open ? "Sans compte à connecter" : (URL(string: entry.url)?.host() ?? entry.url))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            let names = present(entry)
            if !names.isEmpty || added.contains(entry.id) {
                Label(names.isEmpty || names == [entry.id] ? "Ajouté" : "Déjà là : " + names.joined(separator: ", "), systemImage: "checkmark")
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            } else {
                AsyncButton("Ajouter") { await add(entry) }
                    .glassButton(.primary)
                    .help(entry.open ? "Ajouté à tous tes comptes, rien à connecter" : "Ajouté à tous tes comptes ; ton navigateur s'ouvre pour le connecter")
            }
        }
    }

    /// Avec autorisation : par la passerelle (une autorisation pour tous les comptes, le navigateur s'ouvre une fois).
    /// Sans autorisation, ou ancien format SSE : déclaré tel quel dans tous les comptes.
    private func add(_ entry: MCPLibraryEntry) async {
        let ok: Bool
        if entry.open || entry.type != "http" || !entry.viaGateway {
            let config: JSONValue = ["type": .string(entry.type), "url": .string(entry.url), "headers": .object([:])]
            ok = await store.mcpUser("add", name: entry.id, config: config, accounts: accounts.map(\.id))
            if ok && !entry.open { await store.mcpConnectEverywhere(name: entry.id) }
        } else {
            ok = await store.gateway("add", name: entry.id, ["url": .string(entry.url)])
        }
        if ok { added.insert(entry.id) }
    }
}
