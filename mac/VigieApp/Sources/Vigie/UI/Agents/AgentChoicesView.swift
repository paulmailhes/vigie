import SwiftUI

/// Des cases à cocher illustrées (champ « choices » d'un AGENT.md) : une tuile par choix, son symbole, cochée ou non.
/// La valeur est la liste des choix cochés, un par ligne, dans l'ordre des options.
struct AgentChoicesView: View {
    let field: AgentField
    @Binding var value: String
    var disabled = false

    private var selected: Set<String> {
        Set(value.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) })
    }

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 170), spacing: 8)], alignment: .leading, spacing: 8) {
            ForEach(field.options, id: \.self) { option in
                tile(option, on: selected.contains(option))
            }
        }
        .disabled(disabled)
    }

    private func tile(_ option: String, on: Bool) -> some View {
        Button {
            var picked = selected
            if on { picked.remove(option) } else { picked.insert(option) }
            value = field.options.filter(picked.contains).joined(separator: "\n")
        } label: {
            HStack(spacing: 8) {
                Image(systemName: field.icon(for: option))
                    .symbolRenderingMode(.hierarchical)
                    .font(.system(size: 15))
                    .frame(width: 22)
                    .foregroundStyle(on ? Theme.action : .secondary)
                Text(option)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: on ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(on ? Theme.action : Color.secondary.opacity(0.5))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .background(on ? Theme.action.opacity(0.10) : Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(on ? Theme.action.opacity(0.55) : Color.secondary.opacity(0.22)))
            .contentShape(RoundedRectangle(cornerRadius: 9))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(option)
        .accessibilityValue(on ? "coché" : "pas coché")
        .accessibilityAddTraits(.isToggle)
    }
}
