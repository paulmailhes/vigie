import SwiftUI

/// Fiche d'une action sensible : qui, la commande exacte, pourquoi, et quoi faire.
struct BlockedActionSheet: View {
    @Environment(VigieStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let item: ReviewItem
    @State private var sending = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            facts
            if let command = item.command, !command.isEmpty {
                commandBlock(command)
            }
            if item.isAwaitingApproval {
                Label("Valable une seule fois, pour cette commande : même outil, mêmes paramètres, même conversation, pendant 2 h.",
                      systemImage: "1.circle")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            footer
        }
        .padding(24)
        .frame(width: 560)
        .frame(minHeight: 320, maxHeight: 640)
    }

    // MARK: En-tête

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            SheetIcon(symbol: Icon.guardRule)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.rule ?? item.title ?? "Action sensible")
                    .font(.title3.bold())
                    .lineLimit(2)
                if item.isAwaitingApproval {
                    Text("Refusée sur le moment : elle attend ton accord dans Vigie")
                        .foregroundStyle(.red)
                } else if waiting {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(remaining(now: store.isDemo ? store.now : context.date))
                            .monospacedDigit()
                            .foregroundStyle(.red)
                    }
                } else {
                    Text(item.state == "waiting" ? "Décide dans VS Code" : "Refusée par le garde-fou : à faire toi-même")
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var waiting: Bool {
        guard item.isPendingDecision else { return false }
        if let expires = item.expiresAt { return expires > store.now }
        return true
    }

    private func remaining(now: Date) -> String {
        guard let expires = item.expiresAt else { return "Attend ta décision" }
        let seconds = max(0, Int(expires.timeIntervalSince(now)))
        if seconds == 0 { return "Délai passé : refusée" }
        return String(format: "Refusée automatiquement dans %d:%02d", seconds / 60, seconds % 60)
    }

    // MARK: Qui, où, pourquoi

    private var facts: some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 6) {
            GridRow {
                Text("Conversation").foregroundStyle(.secondary)
                Text(conversationName)
            }
            GridRow {
                Text("Par").foregroundStyle(.secondary)
                Label(item.byAgent ?? "La conversation elle-même", systemImage: item.byAgent == nil ? "bubble.left" : Icon.agent)
                    .labelStyle(CompactLabelStyle())
            }
            if let reason = reason {
                GridRow {
                    Text("Raison").foregroundStyle(.secondary)
                    Text(reason)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let ts = item.ts {
                GridRow {
                    Text("Quand").foregroundStyle(.secondary)
                    Text(Fmt.when(ts, now: store.now)).monospacedDigit()
                }
            }
        }
    }

    private var conversationName: String {
        item.conversationId.flatMap { store.conversation($0)?.shortTitle } ?? item.conversationTitle ?? "Conversation"
    }

    private var reason: String? {
        var parts: [String] = []
        for part in [item.rule, item.detail] {
            if let part, !part.isEmpty, !parts.contains(part) { parts.append(part) }
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func commandBlock(_ command: String) -> some View {
        ScrollView {
            Text(command)
                .font(.body.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
        }
        .frame(minHeight: 44, maxHeight: 220)
        .fixedSize(horizontal: false, vertical: true)
        .background(.quinary, in: .rect(cornerRadius: 8))
    }

    // MARK: Actions

    private var footer: some View {
        HStack(spacing: 8) {
            Button("Fermer") { dismiss() }
                .keyboardShortcut(.cancelAction)
                .glassButton()
            Spacer()
            if item.isAwaitingApproval {
                if let command = item.command, !command.isEmpty {
                    Button("Copier la commande") {
                        SystemActions.copy(command)
                        store.show(info: "Commande copiée")
                    }
                    .glassButton()
                }
                Button("Refuser") { approve(false) }
                    .glassButton()
                    .disabled(sending)
                Button("Autoriser une fois") { approve(true) }
                    .glassButton(.primary)
                    .disabled(sending)
                    .help("Valable une seule fois, pour cette commande exacte")
            } else if waiting {
                Button("Refuser") { decide(allow: false) }
                    .glassButton()
                    .disabled(sending)
                Button("Autoriser") { decide(allow: true) }
                    .glassButton(.primary)
                    .disabled(sending)
            } else {
                Button("Ignorer") {
                    Task { await store.dismissReview(item) }
                    dismiss()
                }
                .glassButton()
                .help("Retirer de « À regarder »")
                if let command = item.command, !command.isEmpty {
                    Button("Copier la commande") {
                        SystemActions.copy(command)
                        store.show(info: "Commande copiée")
                    }
                    .glassButton()
                    if item.needsPassword == true {
                        Button("Lancer dans Terminal") {
                            Task { await store.runInTerminal(command, cwd: item.cwd ?? cwd) }
                            dismiss()
                        }
                        .glassButton()
                        .help("Prépare la commande dans Terminal : tu appuies sur Entrée et tapes ton mot de passe")
                    }
                }
                Button("Ouvrir la conversation") {
                    Task { await store.openConversationInVSCode(item.conversationId, cwd: item.cwd ?? cwd) }
                    dismiss()
                }
                .glassButton(.primary)
            }
        }
        .controlSize(.large)
    }

    private var cwd: String? {
        item.conversationId.flatMap { store.conversation($0)?.cwd }
    }

    private func approve(_ allow: Bool) {
        sending = true
        Task {
            let ok = await store.decideApproval(item, allow: allow)
            sending = false
            if ok { dismiss() }
        }
    }

    private func decide(allow: Bool) {
        sending = true
        Task {
            let ok = await store.decidePending(item, allow: allow)
            sending = false
            if ok { dismiss() }
        }
    }
}
