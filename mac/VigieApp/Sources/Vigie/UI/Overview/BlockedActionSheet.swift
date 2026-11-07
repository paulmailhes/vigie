import SwiftUI

/// Fiche d'une action sensible : ce que c'est, où, quand, son état (délai avant le refus d'office), la commande exacte,
/// et quoi faire. Une décision s'y prend avec les mêmes mots qu'ailleurs : « Refuser · Autoriser » ; « une fois » est
/// dit ici, en toutes lettres.
struct BlockedActionSheet: View {
    @Environment(VigieStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let item: ReviewItem
    @State private var sending = false
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ObjectHeader(title, info: [conversationName, item.rule == title ? nil : item.rule, item.ts.map { Fmt.when($0, now: store.now) }],
                         icon: Icon.guardRule, iconColor: Theme.alert)
            status
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

    private var title: String {
        item.title ?? item.rule ?? "Action sensible"
    }

    // MARK: État

    /// Où en est l'action : en pause, refusée d'office dans quelques minutes, ou déjà refusée.
    @ViewBuilder
    private var status: some View {
        if item.isAwaitingApproval {
            Label {
                Text(item.holding == true
                     ? "En pause : la conversation attend ton accord ici. Rien ne s'affiche dans VS Code."
                     : "Elle a continué sans cette action : autorise-la ici, elle pourra la relancer.")
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: item.holding == true ? "pause.circle.fill" : "arrow.uturn.forward.circle")
                    .foregroundStyle(Theme.alert)
            }
        } else if waiting {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Label {
                    Text(remaining(now: store.isDemo ? store.now : context.date))
                        .font(.headline)
                        .monospacedDigit()
                        .foregroundStyle(Theme.alertText)
                } icon: {
                    Image(systemName: "timer")
                        .foregroundStyle(Theme.alert)
                }
            }
        } else {
            Text(item.state == "waiting" ? "Décide dans VS Code."
                 : item.failed ? "Autorisée, mais elle a échoué : regarde l'erreur dans la conversation."
                 : item.needsPassword == true ? "Commande administrateur : à lancer toi-même dans Terminal."
                 : "Refusée d'office par le garde-fou : fais-la toi-même si tu en as besoin.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
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
        if seconds == 0 { return "Délai passé : refusée d'office" }
        return String(format: "Sans réponse, refusée d'office dans %d:%02d", seconds / 60, seconds % 60)
    }

    // MARK: Qui, pourquoi

    private var facts: some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 6) {
            GridRow {
                Text("Demandée par").foregroundStyle(.secondary)
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
        }
    }

    private var conversationName: String {
        item.conversationId.flatMap { store.conversation($0)?.shortTitle } ?? item.conversationTitle ?? "Conversation"
    }

    /// Le détail du moteur, s'il ajoute quelque chose à la règle (déjà dite en tête).
    private var reason: String? {
        guard let detail = item.detail, !detail.isEmpty, detail != item.rule else { return nil }
        return detail
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

    /// Sur une ligne si tout tient, sinon les boutons secondaires au-dessus : aucun bouton n'est coupé.
    private var footer: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                closeButton
                Spacer(minLength: 8)
                secondaryButtons
                primaryButtons
            }
            VStack(alignment: .trailing, spacing: 8) {
                HStack(spacing: 8) { secondaryButtons }
                HStack(spacing: 8) {
                    closeButton
                    Spacer(minLength: 8)
                    primaryButtons
                }
            }
        }
        .controlSize(.large)
    }

    private var closeButton: some View {
        Button("Fermer") { dismiss() }
            .keyboardShortcut(.cancelAction)
            .glassButton()
    }

    @ViewBuilder
    private var secondaryButtons: some View {
        if item.isAwaitingApproval {
            copyButton
        } else if !waiting {
            Button("Retirer") {
                Task { await store.dismissReview(item) }
                dismiss()
            }
            .glassButton()
            .help("Retirer de « À regarder »")
            copyButton
            if let command = item.command, !command.isEmpty, item.needsPassword == true {
                Button("Lancer dans Terminal") {
                    Task { await store.runInTerminal(command, cwd: item.cwd ?? cwd) }
                    dismiss()
                }
                .glassButton()
                .help("Prépare la commande dans Terminal : tu appuies sur Entrée et tapes ton mot de passe")
            }
        }
    }

    @ViewBuilder
    private var primaryButtons: some View {
        if item.isAwaitingApproval {
            Button("Refuser") { approve(false) }
                .glassButton()
                .disabled(sending)
                .help("Refuser cette fois : Claude ne la fait pas")
            Button("Autoriser") { approve(true) }
                .glassButton(.primary)
                .disabled(sending)
                .help("Autoriser une fois, pour cette commande exacte")
        } else if waiting {
            Button("Refuser") { decide(allow: false) }
                .glassButton()
                .disabled(sending)
                .help("Refuser cette fois : Claude ne la fait pas")
            Button("Autoriser") { decide(allow: true) }
                .glassButton(.primary)
                .disabled(sending)
                .help("Autoriser une fois")
        } else {
            Button(item.conversationId.flatMap { store.conversation($0)?.openLabel } ?? "Ouvrir dans VS Code") {
                Task { await store.openConversationInVSCode(item.conversationId, cwd: item.cwd ?? cwd) }
                dismiss()
            }
            .glassButton(.primary)
        }
    }

    @ViewBuilder
    private var copyButton: some View {
        if let command = item.command, !command.isEmpty {
            Button(copied ? "Copiée" : "Copier la commande", systemImage: copied ? "checkmark" : "doc.on.doc") {
                SystemActions.copy(command)
                copied = true
            }
            .glassButton()
        }
    }

    private var cwd: String? {
        item.conversationId.flatMap { store.conversation($0)?.cwd }
    }

    // Tout de suite : la fiche se ferme et l'élément disparaît ; il revient avec un message seulement si ça échoue.
    private func approve(_ allow: Bool) {
        dismiss()
        Task { _ = await store.decideApproval(item, allow: allow) }
    }

    private func decide(allow: Bool) {
        dismiss()
        Task { _ = await store.decidePending(item, allow: allow) }
    }
}
