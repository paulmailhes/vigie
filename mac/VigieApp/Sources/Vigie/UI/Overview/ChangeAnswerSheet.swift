import SwiftUI

/// « Changer » : L'utilisateur choisit une autre option ; l'app prépare le message de correction.
struct ChangeAnswerSheet: View {
    @Environment(VigieStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let item: ReviewItem

    /// Question → option choisie par l'utilisateur (absente = choix de Claude conservé).
    @State private var picks: [String: Set<String>] = [:]
    @State private var result: WriteResult?
    @State private var sending = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            header
            if let result {
                correctionView(result)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        ForEach(Array(questions.enumerated()), id: \.element.key) { _, question in
                            questionBlock(question)
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
            }
            footer
        }
        .padding(24)
        .frame(width: 560)
        .frame(minHeight: 360, maxHeight: 620)
    }

    private var questions: [QuestionItem] {
        let items = item.question?.items ?? []
        if items.isEmpty, let title = item.title {
            return [QuestionItem(question: title, header: nil, multiSelect: false,
                                 options: Lossy(wrappedValue: []), chosen: nil)]
        }
        return items
    }

    // MARK: En-tête

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            SheetIcon(symbol: "questionmark.bubble")
            VStack(alignment: .leading, spacing: 2) {
                Text(result == nil ? "Changer la réponse" : "Message de correction")
                    .font(.title3.bold())
                Text([item.conversationTitle, item.ts.map { Fmt.when($0) }].compactMap { $0 }.joined(separator: " · "))
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: Choix

    private func questionBlock(_ question: QuestionItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("« \(question.question ?? question.header ?? "Question") »")
                .font(.headline)
            VStack(spacing: 6) {
                ForEach(Array(question.options.enumerated()), id: \.offset) { _, option in
                    optionRow(option, in: question)
                }
            }
        }
    }

    private func optionRow(_ option: QuestionOption, in question: QuestionItem) -> some View {
        let label = option.label ?? ""
        let selected = selection(for: question).contains(label)
        let claudeChoice = question.chosenLabels.contains(label)
        return Button {
            toggle(label, in: question)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(selected ? Color.accentColor : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(label).bold()
                        if claudeChoice {
                            Pill(text: "Choix de Claude", symbol: "sparkles")
                        }
                    }
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
            .background(selected ? Color.accentColor.opacity(0.10) : Color.clear, in: .rect(cornerRadius: 10))
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(selected ? Color.accentColor.opacity(0.6) : Color.secondary.opacity(0.25))
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func selection(for question: QuestionItem) -> Set<String> {
        picks[question.key] ?? Set(question.chosenLabels)
    }

    private func toggle(_ label: String, in question: QuestionItem) {
        if question.multiSelect == true {
            var current = selection(for: question)
            if current.contains(label) { current.remove(label) } else { current.insert(label) }
            picks[question.key] = current
        } else {
            picks[question.key] = [label]
        }
    }

    /// Réponses qui diffèrent du choix de Claude.
    private var changedAnswers: [String: String] {
        var answers: [String: String] = [:]
        for question in questions {
            let chosen = selection(for: question)
            guard chosen != Set(question.chosenLabels), !chosen.isEmpty else { continue }
            let ordered = question.options.compactMap(\.label).filter { chosen.contains($0) }
            answers[question.key] = ordered.joined(separator: ", ")
        }
        return answers
    }

    // MARK: Correction

    private func correctionView(_ result: WriteResult) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(result.correction ?? "Correction envoyée.")
                .textSelection(.enabled)
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quinary, in: .rect(cornerRadius: 12))
            if result.delivered == true {
                Label("Envoyé à la conversation", systemImage: "checkmark.circle")
                    .foregroundStyle(.secondary)
            } else {
                Label("Colle-le dans la conversation", systemImage: "doc.on.clipboard")
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: Boutons

    private var footer: some View {
        HStack {
            Spacer()
            if let result {
                if result.delivered == true {
                    Button("Fermer") { dismiss() }
                        .keyboardShortcut(.defaultAction)
                        .glassButton(.primary)
                } else {
                    Button("Fermer") { dismiss() }
                        .keyboardShortcut(.cancelAction)
                        .glassButton()
                    Button("Copier et ouvrir la conversation", systemImage: "arrow.up.forward.app") {
                        copyAndOpen(result)
                    }
                    .keyboardShortcut(.defaultAction)
                    .glassButton(.primary)
                }
            } else {
                Button("Annuler") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .glassButton()
                Button {
                    send()
                } label: {
                    if sending {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Corriger")
                    }
                }
                .keyboardShortcut(.defaultAction)
                .glassButton(.primary)
                .disabled(changedAnswers.isEmpty || sending)
            }
        }
        .controlSize(.large)
    }

    private func send() {
        sending = true
        let answers = changedAnswers
        Task {
            let response = await store.changeReview(item, answers: answers)
            sending = false
            if let response { result = response }
        }
    }

    private func copyAndOpen(_ result: WriteResult) {
        if let text = result.correction { SystemActions.copy(text) }
        if let link = result.openUrl, !link.isEmpty {
            SystemActions.open(link)
        } else if let id = item.conversationId, let cwd = store.conversation(id)?.cwd {
            SystemActions.openInVSCode(path: cwd)
        } else {
            SystemActions.activateVSCode()
        }
        store.show(info: "Message copié : colle-le dans la conversation")
        dismiss()
    }
}
