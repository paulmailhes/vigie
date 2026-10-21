import SwiftUI

/// Répondre depuis Vigie à une question que Claude attend : ses choix, comme dans VS Code.
struct AnswerQuestionSheet: View {
    @Environment(VigieStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let item: ReviewItem

    /// Choix par question (plusieurs pour une question à choix multiples).
    @State private var picks: [String: Set<String>] = [:]
    @State private var sending = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                SheetIcon(symbol: Icon.question)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Claude te pose une question").font(.title3.bold())
                    if let title = item.conversationTitle {
                        Text(title).foregroundStyle(.secondary)
                    }
                }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    ForEach(item.questions, id: \.question) { question in
                        questionView(question)
                    }
                }
            }
            .frame(maxHeight: 420)
            HStack {
                Button("Annuler") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .glassButton()
                Spacer()
                Button(sending ? "Envoi…" : "Envoyer la réponse") { send() }
                    .keyboardShortcut(.defaultAction)
                    .glassButton(.primary)
                    .disabled(!complete || sending)
            }
            .controlSize(.large)
        }
        .padding(24)
        .frame(width: 560)
        .onAppear(perform: preselect)
    }

    private func questionView(_ question: PendingQuestion) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let header = question.header, !header.isEmpty {
                Text(header.uppercased())
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            Text(question.question)
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(question.options, id: \.label) { option in
                let selected = picks[question.question, default: []].contains(option.label)
                Button {
                    toggle(option.label, in: question)
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: question.multiSelect == true
                              ? (selected ? "checkmark.square.fill" : "square")
                              : (selected ? "largecircle.fill.circle" : "circle"))
                            .foregroundStyle(selected ? AnyShapeStyle(Theme.action) : AnyShapeStyle(.secondary))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(option.label)
                            if let description = option.description, !description.isEmpty {
                                Text(description)
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(10)
                    .background(selected ? AnyShapeStyle(Theme.action.opacity(0.10)) : AnyShapeStyle(.quinary), in: .rect(cornerRadius: 10))
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// L'option recommandée est cochée d'avance, comme le ferait Claude.
    private func preselect() {
        for question in item.questions where picks[question.question] == nil {
            if let recommended = question.options.first(where: { $0.label.localizedCaseInsensitiveContains("recommand") }) {
                picks[question.question] = [recommended.label]
            }
        }
    }

    private func toggle(_ label: String, in question: PendingQuestion) {
        var set = picks[question.question, default: []]
        if question.multiSelect == true {
            if set.contains(label) { set.remove(label) } else { set.insert(label) }
        } else {
            set = [label]
        }
        picks[question.question] = set
    }

    private var complete: Bool {
        item.questions.allSatisfy { !(picks[$0.question] ?? []).isEmpty }
    }

    private func send() {
        sending = true
        var answers: [String: String] = [:]
        for question in item.questions {
            let chosen = question.options.map(\.label).filter { picks[question.question, default: []].contains($0) }
            answers[question.question] = chosen.joined(separator: ", ")
        }
        Task {
            if await store.answerPending(item, answers: answers) { dismiss() }
            sending = false
        }
    }
}
