import SwiftUI

/// Les MCP dont un agent a besoin (Figma, Webflow…), le même module partout : la carte de l'agent (pastilles et un
/// petit « Vérifier ») et le bloc « Outils » de son formulaire (le MCP choisi, son état, de quoi le connecter).
/// L'état suit le moteur à la seconde : une vérification, une connexion ou une autorisation arrive par
/// GET /api/v2/changes (VigieStore.followAgents).

/// L'état d'un MCP pour un agent, en un mot et une couleur : vert quand il est prêt, orange quand il faut agir, rouge
/// en échec, gris tant qu'on ne sait pas.
enum AgentMCPState: Equatable {
    case ready, toConnect, toAdd, toApprove, failed, off, unchecked, checking

    init(_ mcp: AgentMCP, checking: Bool) {
        if checking { self = .checking; return }
        if mcp.isMissing { self = .toAdd; return }
        switch mcp.mcpStatus {
        case .connected: self = .ready
        case .needsAuth: self = .toConnect
        case .pendingApproval: self = .toApprove
        case .failed: self = .failed
        case .disabled: self = .off
        case .unknown: self = .unchecked
        }
    }

    var label: String {
        switch self {
        case .ready: "prêt"
        case .toConnect: "à connecter"
        case .toAdd: "à ajouter"
        case .toApprove: "à approuver"
        case .failed: "en échec"
        case .off: "coupé"
        case .unchecked: "pas vérifié"
        case .checking: "vérification…"
        }
    }

    var symbol: String {
        switch self {
        case .ready: "checkmark.circle.fill"
        case .toConnect: "person.crop.circle.badge.exclamationmark"
        case .toAdd: "plus.circle"
        case .toApprove: "hourglass"
        case .failed: "xmark.octagon.fill"
        case .off: "pause.circle"
        case .unchecked, .checking: "circle.dashed"
        }
    }

    var color: Color {
        switch self {
        case .ready: Theme.live
        case .toConnect, .toAdd, .toApprove: Theme.warn
        case .failed: Theme.alert
        case .off, .unchecked, .checking: .secondary
        }
    }
}

extension VigieStore {
    /// Le MCP choisi de ce besoin est en cours de vérification.
    func isVerifying(_ mcp: AgentMCP) -> Bool {
        mcp.chosen.map(verifying.contains) ?? false
    }
}

/// Les besoins d'un agent, une fois chacun (deux lignes « figma » et « figma-pro » d'un AGENT.md : un seul Figma).
extension AgentInfo {
    var mcpNeeds: [AgentMCP] {
        var seen = Set<String>()
        return mcp.filter { seen.insert($0.key).inserted }
    }

    /// Tout ce dont il a besoin est prêt.
    var mcpReady: Bool { mcpNeeds.allSatisfy { $0.mcpStatus == .connected && !$0.isMissing } }

    /// Il y a quelque chose à vérifier (un MCP choisi).
    var canVerifyMCP: Bool { mcpNeeds.contains { $0.chosen != nil } }
}

// MARK: Carte de l'agent

/// Sur la carte : une pastille par MCP, un petit « Vérifier », et de quoi régler ce qui manque, sans ouvrir l'agent.
struct AgentMCPStrip: View {
    @Environment(VigieStore.self) private var store
    let agent: AgentInfo

    var body: some View {
        FlowLayout(spacing: 6) {
            ForEach(agent.mcpNeeds) { mcp in
                AgentMCPChip(mcp: mcp, state: AgentMCPState(mcp, checking: store.isVerifying(mcp)))
            }
            AgentMCPVerifyButton(agent: agent, compact: true)
                .padding(.top, 1)
            AgentMCPFixes(agent: agent)
                .buttonStyle(.link)
                .font(.caption)
                .padding(.top, 3)
        }
    }
}

/// Une pastille : le service, le MCP utilisé quand son nom en dit plus (« Figma · figma-pro »), l'état en couleur.
struct AgentMCPChip: View {
    let mcp: AgentMCP
    let state: AgentMCPState

    var body: some View {
        HStack(spacing: 5) {
            ServiceGlyph(service: mcp.service, name: mcp.title, size: 11)
            Text(mcp.title)
                .fontWeight(.medium)
            if let detail = mcp.chosenDetail {
                Text(detail)
                    .foregroundStyle(.secondary)
            }
            if let space = mcp.servers.first(where: { $0.name == mcp.chosen })?.spaceLabel {
                Text(space)
                    .foregroundStyle(.secondary)
            }
            AgentMCPStateLabel(state: state)
        }
        .font(.caption)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(state.color.opacity(state == .ready ? 0.14 : 0.10), in: .capsule)
        .overlay(Capsule().strokeBorder(state.color.opacity(0.25), lineWidth: 0.5))
        .fixedSize()
        .help(mcp.servers.count > 1 ? "L'agent utilisera \(mcp.chosen ?? mcp.title) ; un autre se choisit au lancement" : "")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(mcp.title)\(mcp.chosenDetail.map { " (\($0))" } ?? "") : \(state.label)")
    }
}

/// L'état : son symbole et son mot, dans sa couleur ; un indicateur pendant la vérification.
struct AgentMCPStateLabel: View {
    let state: AgentMCPState

    var body: some View {
        HStack(spacing: 3) {
            if state == .checking {
                ProgressView()
                    .controlSize(.mini)
                    .scaleEffect(0.7)
                    .frame(width: 10, height: 10)
            } else {
                Image(systemName: state.symbol)
                    .imageScale(.small)
            }
            Text(state.label)
        }
        .foregroundStyle(state.color)
    }
}

/// « Vérifier » : les MCP choisis de l'agent, vérifiés seuls (quelques secondes). `compact` : une simple flèche.
struct AgentMCPVerifyButton: View {
    @Environment(VigieStore.self) private var store
    let agent: AgentInfo
    var compact = false

    var body: some View {
        let busy = agent.mcpNeeds.contains(where: store.isVerifying)
        Button {
            Task { await store.verifyAgentMCP(agent) }
        } label: {
            if compact {
                Image(systemName: "arrow.clockwise")
                    .imageScale(.small)
            } else {
                Label("Vérifier", systemImage: "arrow.clockwise")
            }
        }
        .buttonStyle(.borderless)
        .controlSize(compact ? .mini : .small)
        .disabled(busy || !agent.canVerifyMCP)
        .help("Vérifier tout de suite l'état de \(agent.mcpNeeds.map(\.title).formatted(.list(type: .and).locale(Fmt.locale))) (quelques secondes)")
        .accessibilityLabel("Vérifier ses MCP")
    }
}

/// Ce qui manque, réglable d'ici : « Ajouter Figma » (le MCP officiel, sur tous les comptes, puis la page
/// d'autorisation), « Connecter Figma » (sur le compte des nouvelles conversations) ; le reste par la page MCP.
struct AgentMCPFixes: View {
    @Environment(VigieStore.self) private var store
    let agent: AgentInfo

    var body: some View {
        let toFix = agent.mcpNeeds.filter { $0.isMissing || [.needsAuth, .failed, .pendingApproval, .disabled].contains($0.mcpStatus) }
        ForEach(toFix) { AgentMCPFix(mcp: $0, titled: true) }
        if toFix.contains(where: { !Self.fixedHere($0) }) {
            Button("Régler dans MCP") { store.route = .mcp }
                .help("Ouvre la page MCP pour connecter ce qui manque")
        }
    }

    nonisolated static func fixedHere(_ mcp: AgentMCP) -> Bool {
        (mcp.isMissing && mcp.libraryEntry != nil) || (mcp.connect != nil && [.needsAuth, .failed].contains(mcp.mcpStatus))
    }
}

/// Le geste qui règle un MCP : l'ajouter, ou le connecter. `titled` : « Connecter Figma » (sinon « Connecter »).
struct AgentMCPFix: View {
    @Environment(VigieStore.self) private var store
    let mcp: AgentMCP
    var titled = false

    var body: some View {
        if mcp.isMissing, let entry = mcp.libraryEntry {
            AsyncButton(titled ? "Ajouter \(mcp.title)" : "Ajouter") {
                if await entry.add(in: store) { await store.refreshAgents() }
            }
            .help("Ajoute le MCP officiel \(mcp.title) à tes comptes ; ton navigateur s'ouvre pour le connecter")
        } else if let name = mcp.connect, [.needsAuth, .failed].contains(mcp.mcpStatus) {
            AsyncButton(titled ? "Connecter \(mcp.title)" : "Connecter") {
                await store.mcpConnect(name: name, accountId: store.agentsState?.account?.id, path: nil)
            }
            .help("Ouvre ton navigateur pour connecter \(mcp.title) (\(name)) ; l'état change dès que c'est autorisé")
        }
    }
}

// MARK: Formulaire de lancement

/// Le bloc « Outils » du formulaire : chaque MCP dont l'agent a besoin, celui qu'il utilisera (au choix quand il y en a
/// plusieurs), son état, et de quoi le connecter ou le vérifier. Vert partout : l'agent a ce qu'il lui faut.
struct AgentMCPPanel: View {
    @Environment(VigieStore.self) private var store
    let agent: AgentInfo
    @Binding var picks: [String: String]
    var disabled = false

    var body: some View {
        let needs = agent.mcpNeeds
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Outils")
                    .fontWeight(.medium)
                summary(needs)
                Spacer()
                AgentMCPVerifyButton(agent: agent)
            }
            VStack(spacing: 0) {
                ForEach(Array(needs.enumerated()), id: \.element.id) { index, mcp in
                    if index > 0 { Divider().padding(.leading, 40) }
                    row(mcp)
                }
            }
            .background(.quinary, in: RoundedRectangle(cornerRadius: Theme.corner))
        }
    }

    /// L'espace de travail d'un MCP de la passerelle (Webflow) : le choisir ici l'active pour tous les comptes, comme
    /// sur la page MCP ; l'agent ne verra que lui (le brief le nomme).
    @ViewBuilder
    private func spaceChoice(_ server: AgentMCPServer) -> some View {
        if server.spaces.count > 1 {
            Picker("Espace", selection: Binding { server.space ?? server.spaces[0].id } set: { id in
                Task {
                    _ = await store.gateway("activate", name: server.name, ["profileId": .string(id)])
                    await store.refreshAgents()
                }
            }) {
                ForEach(server.spaces) { Text("Espace \($0.label)").tag($0.id) }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .controlSize(.small)
            .fixedSize()
            .disabled(disabled)
            .help("L'espace de travail que l'agent verra (il devient l'espace actif de \(server.name) pour tous tes comptes)")
        } else if let label = server.spaceLabel {
            Text("Espace \(label)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func summary(_ needs: [AgentMCP]) -> some View {
        let waiting = needs.filter { $0.isMissing || $0.mcpStatus != .connected }
        if waiting.isEmpty {
            Label("Tout est prêt", systemImage: "checkmark.circle.fill")
                .font(.caption)
                .foregroundStyle(Theme.live)
        } else if waiting.allSatisfy({ !$0.isMissing && $0.mcpStatus == .unknown }) {
            Text("À vérifier")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else {
            Text(waiting.count == 1 ? "1 à régler avant de lancer" : "\(waiting.count) à régler avant de lancer")
                .font(.caption)
                .foregroundStyle(Theme.warn)
        }
    }

    private func row(_ mcp: AgentMCP) -> some View {
        let state = AgentMCPState(mcp, checking: store.isVerifying(mcp))
        return HStack(spacing: 10) {
            ServiceGlyph(service: mcp.service, name: mcp.title, size: 18)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(mcp.title)
                    .fontWeight(.medium)
                if mcp.servers.count > 1 {
                    Picker("MCP utilisé", selection: Binding { mcp.chosen ?? mcp.servers.first?.name ?? "" } set: { picks[mcp.key] = $0 }) {
                        ForEach(mcp.servers) { server in
                            Text("\(server.name) — \(AgentMCPState(mcp.picking(server.name), checking: false).label)").tag(server.name)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .controlSize(.small)
                    .fixedSize()
                    .disabled(disabled)
                    .help("L'agent n'utilisera que celui-ci ; Vigie s'en souviendra la prochaine fois")
                } else if let detail = mcp.chosen ?? (mcp.isMissing ? "Aucun \(mcp.title) sur ce compte" : nil) {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let server = mcp.servers.first(where: { $0.name == mcp.chosen }), !server.spaces.isEmpty {
                    spaceChoice(server)
                }
            }
            Spacer(minLength: 8)
            AgentMCPStateLabel(state: state)
                .font(.callout)
            AgentMCPFix(mcp: mcp)
                .controlSize(.small)
            if !AgentMCPFixes.fixedHere(mcp), mcp.isMissing || [.needsAuth, .failed, .pendingApproval, .disabled].contains(mcp.mcpStatus) {
                Text("page MCP")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .help("À régler sur la page MCP de Vigie")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }
}
