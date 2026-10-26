import SwiftUI

/// Message qui flotte en bas de la fenêtre (verre : élément flottant) : trois lignes au plus, et un message long reste
/// plus longtemps (une consigne coupée ou disparue trop vite ne sert à rien).
struct ToastView: View {
    let toast: Toast
    let dismiss: (UUID) -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: toast.isError ? "exclamationmark.triangle.fill" : "checkmark.circle")
                .foregroundStyle(toast.isError ? AnyShapeStyle(Color.red) : AnyShapeStyle(.secondary))
            Text(toast.text)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
            Button("Fermer", systemImage: "xmark") { dismiss(toast.id) }
                .labelStyle(.iconOnly)
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
        }
        .font(.callout)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .glassEffect(.regular.tint(toast.isError ? Color.red.opacity(0.10) : nil), in: .rect(cornerRadius: 18))
        .frame(maxWidth: 560)
        .task(id: toast.id) {
            try? await Task.sleep(for: .seconds(min(14, 6 + max(0, toast.text.count - 80) / 30)))
            dismiss(toast.id)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
    }
}

/// Bandeau discret quand le moteur ne répond pas, avec « Relancer ».
struct EngineBanner: View {
    let connection: Connection
    let restarting: Bool
    let restart: () -> Void

    var body: some View {
        GlassEffectContainer(spacing: 8) {
            HStack(spacing: 8) {
                Label(message, systemImage: "bolt.horizontal.circle")
                    .lineLimit(1)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .glassEffect(.regular, in: .capsule)
                Button(action: restart) {
                    if restarting {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Relancer", systemImage: "arrow.clockwise")
                    }
                }
                .glassButton(.primary)
                .disabled(restarting)
            }
        }
        .font(.callout)
    }

    private var message: String {
        switch connection {
        case .failing(let text): text
        default: "Le moteur de Vigie ne répond pas"
        }
    }
}

/// Premier lancement de l'app glissée dans Applications : le moteur s'installe (Node.js peut être téléchargé).
struct SetupBanner: View {
    let setup: VigieStore.Setup
    let retry: () -> Void

    var body: some View {
        GlassEffectContainer(spacing: 8) {
            HStack(spacing: 8) {
                HStack(spacing: 8) {
                    if setup == .installing {
                        ProgressView().controlSize(.small)
                        Text("Installation de Vigie… (jusqu'à une minute la première fois)")
                    } else if case .failed(let message) = setup {
                        Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.warn)
                        Text("Installation non aboutie : \(message)").lineLimit(2)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .glassEffect(.regular, in: .capsule)
                if case .failed = setup {
                    Button("Réessayer", systemImage: "arrow.clockwise", action: retry)
                        .glassButton(.primary)
                }
            }
        }
        .font(.callout)
    }
}
