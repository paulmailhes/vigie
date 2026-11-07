import SwiftUI

/// Message qui flotte en bas de la fenêtre (verre : élément flottant) : trois lignes au plus, et un message long reste
/// plus longtemps (une consigne coupée ou disparue trop vite ne sert à rien). VoiceOver l'annonce à son apparition ;
/// l'icône et le texte se lisent ensemble, la croix reste un bouton à part.
struct ToastView: View {
    let toast: Toast
    let dismiss: (UUID) -> Void

    var body: some View {
        HStack(spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: toast.isError ? "exclamationmark.triangle.fill" : "checkmark.circle")
                    .foregroundStyle(toast.isError ? AnyShapeStyle(Theme.alert) : AnyShapeStyle(.secondary))
                    .accessibilityHidden(true)
                // une phrase, parfois longue : en couleur normale, seule l'icône dit l'erreur
                Text(toast.text)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(spoken)
            IconButton("Fermer", systemImage: "xmark") { dismiss(toast.id) }
        }
        .font(.callout)
        .padding(.leading, 14)
        .padding(.trailing, 4)
        .padding(.vertical, 2)
        .glassEffect(.regular.tint(toast.isError ? Theme.alert.opacity(0.10) : nil), in: .rect(cornerRadius: 18))
        .frame(maxWidth: 560)
        .task(id: toast.id) {
            AccessibilityNotification.Announcement(spoken).post()
            try? await Task.sleep(for: .seconds(min(14, 6 + max(0, toast.text.count - 80) / 30)))
            dismiss(toast.id)
        }
    }

    /// Ce que VoiceOver lit (et annonce) : « Erreur : … » pour une erreur, l'icône seule ne se lit pas.
    private var spoken: String {
        toast.isError ? "Erreur : \(toast.text)" : toast.text
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
