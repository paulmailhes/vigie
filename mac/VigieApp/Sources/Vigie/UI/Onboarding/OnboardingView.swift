import SwiftUI
import UserNotifications

/// Premier lancement : ce qu'est Vigie, les actions sensibles, les comptes Claude, puis on active.
/// Revoir à tout moment : menu Vigie > Revoir l'accueil.
struct OnboardingView: View {
    @Environment(VigieStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @AppStorage(OnboardingView.doneKey) private var done = false
    @State private var step = 0

    static let doneKey = "onboarding.done"
    private let steps = 4

    var body: some View {
        VStack(spacing: 0) {
            Group {
                switch step {
                case 0: welcome
                case 1: guards
                case 2: accounts
                default: ready
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(.horizontal, 36)
            .padding(.top, 32)

            footer
                .padding(.horizontal, 36)
                .padding(.vertical, 20)
        }
        .frame(width: 600, height: 560)
        .task { await store.refreshAccounts() }
    }

    // MARK: 1. Bienvenue

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 22) {
            Image(systemName: "binoculars.fill")
                .font(.system(size: 44))
                .foregroundStyle(Theme.action)
            VStack(alignment: .leading, spacing: 8) {
                Text("Bienvenue dans Vigie").font(.largeTitle.bold())
                Text("Vigie veille sur Claude Code pendant que tu travailles… ou pendant que tu dors.")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 16) {
                point("checkmark.shield", "Il valide pour toi les demandes d'autorisation",
                      "Plus besoin de cliquer « Oui » toute la journée : les commandes, les fichiers, les outils passent tout seuls, dans toutes tes conversations.")
                point("hand.raised", "Il garde pour toi les actions sensibles",
                      "Suppressions, sudo, git push forcé, paiements, e-mails, réglages : ça attend toujours ton accord.")
                point("square.grid.2x2", "Il te montre où en est chaque conversation",
                      "Ce qu'elle fait, sur quel compte, ce qu'elle consomme, ses MCP, et ce qui t'attend.")
            }
            Text("Tout se passe sur ton Mac : Vigie n'envoie tes conversations nulle part.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: 2. Actions sensibles

    private var guards: some View {
        @Bindable var store = store
        return VStack(alignment: .leading, spacing: 20) {
            header("hand.raised.fill", "Les actions sensibles restent à toi",
                   "Même avec l'auto-accept, Vigie ne valide jamais ces actions à ta place.")
            FlowChips(items: ["Commande sudo", "Suppression de dossiers importants", "git push forcé", "Effacement de disque",
                              "Paiements et achats", "Envoi d'e-mails", "Publication sur les réseaux", "Réglages de Claude Code et du shell"])
            VStack(alignment: .leading, spacing: 10) {
                Text("Où veux-tu les autoriser ?").font(.headline)
                Picker("Où autoriser", selection: $store.guardMode) {
                    Text("Dans Vigie (recommandé) : l'action attend, tu reçois une notification, un clic suffit").tag("vigie")
                    Text("Dans VS Code : la fenêtre habituelle de Claude Code").tag("vscode")
                }
                .pickerStyle(.radioGroup)
                .labelsHidden()
            }
            Text("Tu peux ajuster la liste plus tard dans Réglages (⌘,).")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: 3. Comptes

    @State private var showAdd = false

    private var accounts: some View {
        VStack(alignment: .leading, spacing: 18) {
            header("person.2.crop.square.stack", "Tes comptes Claude",
                   "Plusieurs abonnements ? Ajoute-les : ils restent connectés, et tu choisis le compte de chaque conversation.")
            VStack(spacing: 0) {
                ForEach(store.accounts) { account in
                    OnboardingAccountRow(account: account)
                    if account.id != store.accounts.last?.id { Divider() }
                }
                if store.accounts.isEmpty {
                    Text("Lecture des comptes…").foregroundStyle(.secondary).padding(12)
                }
            }
            .background(.quinary, in: .rect(cornerRadius: Theme.corner))
            Button("Ajouter un compte", systemImage: "plus") { showAdd = true }
                .glassButton()
            if store.accounts.count > 1 {
                Toggle(isOn: Binding(get: { store.accountsState?.wrapper?.active == true },
                                     set: { on in Task { await store.setWrapper(on) } })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Un compte par conversation dans VS Code")
                        Text("Vigie lance chaque conversation sur le compte que tu lui choisis.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
                .toggleStyle(.switch)
            }
            Text("Un seul compte ? Rien à faire, tu peux passer.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .sheet(isPresented: $showAdd) { OnboardingAddAccountSheet() }
    }

    // MARK: 4. C'est parti

    @State private var notificationsAsked = false

    private var ready: some View {
        @Bindable var store = store
        return VStack(alignment: .leading, spacing: 20) {
            header("checkmark.seal.fill", "C'est prêt", "Trois réglages, modifiables à tout moment.")
            VStack(spacing: 0) {
                setting("Auto-accept", "Valide les demandes d'autorisation dans toutes tes conversations (sauf les actions sensibles).",
                        isOn: $store.autoAccept)
                Divider()
                setting("Répondre aux questions quand tu n'es pas là",
                        "Si Claude te pose une question et que tu ne réponds pas en \(store.questionWaitMin) min, il prend l'option recommandée. Tu relis ensuite dans Vigie.",
                        isOn: $store.questionsAuto)
                Divider()
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Notifications")
                        Text("Pour savoir quand une action t'attend ou qu'une conversation s'emballe.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(notificationsAsked ? "Demandé" : "Autoriser") {
                        notificationsAsked = true
                        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
                    }
                    .glassButton()
                    .disabled(notificationsAsked)
                }
                .padding(12)
            }
            .background(.quinary, in: .rect(cornerRadius: Theme.corner))
            Text("Vigie vit dans la barre des menus (les jumelles). Ferme cette fenêtre quand tu veux : il continue de veiller.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: Pied

    private var footer: some View {
        HStack {
            HStack(spacing: 6) {
                ForEach(0..<steps, id: \.self) { index in
                    Circle()
                        .fill(index == step ? AnyShapeStyle(Theme.action) : AnyShapeStyle(.quaternary))
                        .frame(width: 7, height: 7)
                }
            }
            Spacer()
            if step > 0 {
                Button("Retour") { withAnimation(.smooth) { step -= 1 } }
                    .glassButton()
            }
            Button(step == steps - 1 ? "Commencer" : "Continuer") {
                if step == steps - 1 {
                    done = true
                    dismiss()
                } else {
                    withAnimation(.smooth) { step += 1 }
                }
            }
            .keyboardShortcut(.defaultAction)
            .glassButton(.primary)
        }
        .controlSize(.large)
    }

    // MARK: Briques

    private func header(_ symbol: String, _ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: symbol)
                .font(.system(size: 30))
                .foregroundStyle(Theme.action)
            Text(title).font(.title.bold())
            Text(text)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func point(_ symbol: String, _ title: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(Theme.action)
                .frame(width: 30)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.headline)
                Text(text)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func setting(_ title: String, _ text: String, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(text)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .toggleStyle(.switch)
        .padding(12)
    }
}

/// Un compte : son nom, son adresse, « Connecté » ou « Connecter » (le navigateur s'ouvre).
struct OnboardingAccountRow: View {
    @Environment(VigieStore.self) private var store
    let account: Account

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: account.isConnected ? "person.crop.circle.badge.checkmark" : "person.crop.circle")
                .font(.title2)
                .foregroundStyle(account.isConnected ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
            VStack(alignment: .leading, spacing: 1) {
                Text(account.displayName).font(.headline)
                Text(account.email ?? account.expectedEmail ?? (account.isConnected ? "Connecté" : "Pas encore connecté"))
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if account.isConnected {
                Label("Connecté", systemImage: "checkmark")
                    .foregroundStyle(.secondary)
            } else {
                Button("Connecter") { Task { await store.connectAccount(account.id) } }
                    .glassButton(.primary)
                    .help("Ouvre la page de connexion de Claude dans ton navigateur")
            }
        }
        .padding(12)
    }
}

/// Ajouter un compte : un nom et son adresse, puis la connexion s'ouvre dans le navigateur.
struct OnboardingAddAccountSheet: View {
    @Environment(VigieStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var email = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                SheetIcon(symbol: "person.crop.circle.badge.plus")
                Text("Ajouter un compte Claude").font(.title3.bold())
            }
            TextField("Nom", text: $label, prompt: Text("Travail, Perso, Client…"))
                .textFieldStyle(.roundedBorder)
            TextField("Adresse e-mail du compte", text: $email, prompt: Text("toi@exemple.fr"))
                .textFieldStyle(.roundedBorder)
            Text("Ton navigateur s'ouvre ensuite sur la page de connexion de Claude : connecte-toi avec cette adresse.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Annuler") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .glassButton()
                Button("Ajouter et connecter") {
                    let name = label.trimmingCharacters(in: .whitespaces)
                    let address = email.trimmingCharacters(in: .whitespaces)
                    Task { await store.createAndConnectAccount(label: name, email: address.isEmpty ? nil : address) }
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .glassButton(.primary)
                .disabled(label.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .controlSize(.large)
        }
        .padding(24)
        .frame(width: 440)
    }
}

/// Étiquettes qui passent à la ligne.
struct FlowChips: View {
    let items: [String]

    var body: some View {
        FlowLayout(spacing: 8) {
            ForEach(items, id: \.self) { item in
                Text(item)
                    .font(.callout)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(.quinary, in: .capsule)
            }
        }
    }
}

/// Disposition en lignes qui passent à la ligne quand la place manque.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 500
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > width, x > 0 { x = 0; y += line + spacing; line = 0 }
            x += size.width + spacing
            line = max(line, size.height)
        }
        return CGSize(width: width, height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX { x = bounds.minX; y += line + spacing; line = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}
