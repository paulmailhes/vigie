import SwiftUI

/// Un élément « À regarder » : question choisie pour toi, action bloquée, conversation qui attend, limite.
struct ReviewRow: View {
    @Environment(VigieStore.self) private var store
    let item: ReviewItem
    /// Affichée dans la page de sa conversation : « Voir » ouvrirait la même page, on propose VS Code.
    var inConversation = false

    var body: some View {
        let alert = Theme.isAlert(item.reviewKind)
        HStack(spacing: 10) {
            RowIcon(symbol: Theme.symbol(for: item.reviewKind), alert: alert)
            VStack(alignment: .leading, spacing: 2) {
                Text(headline)
                    .foregroundStyle(alert ? AnyShapeStyle(Color.red) : AnyShapeStyle(.primary))
                    .lineLimit(2)
                Text(detailLine)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if item.needsDecision, let command = item.command, !command.isEmpty {
                    Text(command)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .help(command)
                }
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 8)
            actions
        }
        .padding(.vertical, 2)
    }

    private var headline: String {
        let title = item.title ?? ""
        return item.reviewKind == .question ? "« \(title) »" : title
    }

    private var detailLine: String {
        [item.conversationTitle, item.detail, item.ts.map { Fmt.when($0, now: store.now) }]
            .compactMap { $0?.isEmpty == false ? $0 : nil }
            .joined(separator: " · ")
    }

    /// Retirer de « À regarder » ce qui n'attend pas de décision (limite, refus, échec).
    private var dismissButton: some View {
        AsyncButton { await store.dismissReview(item) } label: { Image(systemName: "xmark") }
            .glassButton()
            .help("Retirer")
            .accessibilityLabel("Retirer")
    }

    @ViewBuilder
    private var actions: some View {
        switch item.reviewKind {
        case .question:
            HStack(spacing: 6) {
                AsyncButton("Ça me va") { await store.acceptReview(item) }
                Button("Changer") {
                    store.changeRequest = item
                }
            }
            .glassButton()
        case .limit:
            HStack(spacing: 6) {
                Button("Comptes") {
                    store.showAccounts(item.conversationId.flatMap { store.conversation($0)?.accountId })
                }
                .glassButton()
                dismissButton
            }
        case .blocked where item.isAwaitingApproval:
            HStack(spacing: 6) {
                Button("Voir") { store.blockedRequest = item }
                    .glassButton()
                    .help("La commande exacte")
                AsyncButton("Refuser") { _ = await store.decideApproval(item, allow: false) }
                .glassButton()
                AsyncButton("Autoriser une fois") { _ = await store.decideApproval(item, allow: true) }
                .glassButton(.primary)
                .help("Valable une seule fois, pour cette commande : \(item.command ?? item.title ?? "")")
            }
        case .blocked where item.isPendingDecision:
            // Décider d'ici, sans ouvrir la fiche ; « Voir » reste là pour la commande entière.
            HStack(spacing: 6) {
                Button("Voir") { store.blockedRequest = item }
                    .glassButton()
                    .help("La commande en entier")
                AsyncButton {
                    _ = await store.decidePending(item, allow: false)
                } label: {
                    Image(systemName: "xmark")
                }
                .glassButton()
                .help("Refuser")
                .accessibilityLabel("Refuser")
                AsyncButton {
                    _ = await store.decidePending(item, allow: true)
                } label: {
                    Label("Autoriser", systemImage: "checkmark")
                }
                .glassButton(.primary)
                .help("Autoriser : \(item.command ?? item.title ?? "")")
            }
        case .blocked:
            HStack(spacing: 6) {
                Button("Voir") {
                    store.blockedRequest = item
                }
                .glassButton()
                .help("La commande et quoi faire")
                dismissButton
            }
        case .waiting where !item.questions.isEmpty && item.pendingId != nil:
            Button("Répondre") { store.answerRequest = item }
                .glassButton(.primary)
                .help("Voir la question et y répondre d'ici")
        case .waiting, .other:
            if inConversation {
                AsyncButton(item.conversationId.flatMap { store.conversation($0)?.replyLabel } ?? "Répondre dans VS Code") {
                    await store.openConversationInVSCode(item.conversationId, cwd: item.cwd)
                }
                .glassButton(.primary)
                .help("Ouvre cette conversation dans VS Code")
            } else {
                Button("Voir") {
                    if let id = item.conversationId { store.route = .conversation(id) }
                }
                .glassButton()
                .disabled(item.conversationId == nil)
            }
        }
    }
}

/// Un rapport ou une fin de mission (artefact publié, mission terminée, workflow fini).
struct ReportRow: View {
    @Environment(VigieStore.self) private var store
    let report: Report

    var body: some View {
        HStack(spacing: 10) {
            RowIcon(symbol: Theme.symbol(for: report.reportKind))
            VStack(alignment: .leading, spacing: 2) {
                Text(report.title ?? "Mise à jour")
                    .lineLimit(1)
                Text(detailLine)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 8)
            if let url = report.url, !url.isEmpty {
                Button("Ouvrir") { SystemActions.open(url) }
                    .glassButton()
                    .help("Ouvrir sur claude.ai")
            } else if let id = report.conversationId {
                Button("Voir") { store.route = .conversation(id) }
                    .glassButton()
            }
        }
        .padding(.vertical, 2)
    }

    private var detailLine: String {
        [report.conversationTitle, report.detail, report.ts.map { Fmt.when($0, now: store.now) }]
            .compactMap { $0?.isEmpty == false ? $0 : nil }
            .joined(separator: " · ")
    }
}
