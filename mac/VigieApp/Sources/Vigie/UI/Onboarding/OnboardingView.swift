import SwiftUI
import UserNotifications

/// Les étapes de l'accueil ; Codex n'apparaît que si l'utilisateur s'en sert.
enum OnboardingStep: Hashable {
    case welcome, tools, guards, accounts, codex, mcps, ready
}

/// Premier lancement : ce qu'est Vigie, les outils de l'utilisateur, les actions sensibles, les comptes, Codex,
/// les MCP, puis on active. Revoir à tout moment : menu Vigie > Revoir l'accueil.
struct OnboardingView: View {
    @Environment(VigieStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @AppStorage(OnboardingView.doneKey) private var done = false
    @State private var step: Int
    /// Outils cochés (pré-cochés d'après ce que Vigie trouve sur le Mac).
    @State private var choice = ToolsChoice(claudeVSCode: true)
    @State private var choiceLoaded = false
    /// Codex passé sans approuver ses hooks : on le redit, sans bloquer.
    @State private var codexSkipped = false
    private let startAt: OnboardingStep

    /// `start` : ouvrir directement sur une étape (captures d'écran).
    init(start: OnboardingStep = .welcome) {
        startAt = start
        _step = State(initialValue: 0)
    }

    static let doneKey = "onboarding.done"

    private var steps: [OnboardingStep] {
        var list: [OnboardingStep] = [.welcome, .tools, .guards, .accounts]
        if choice.usesCodex { list.append(.codex) }
        return list + [.mcps, .ready]
    }
    private var current: OnboardingStep { steps[min(step, steps.count - 1)] }

    var body: some View {
        VStack(spacing: 0) {
            // Défile quand l'étape est plus haute que la fenêtre (beaucoup de comptes) : les boutons restent visibles.
            ScrollView {
                Group {
                    switch current {
                    case .welcome: welcome
                    case .tools: toolsStep
                    case .guards: guards
                    case .accounts: accounts
                    case .codex: codexStep
                    case .mcps: mcps
                    case .ready: ready
                    }
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .padding(.horizontal, 36)
                .padding(.top, 32)
                .padding(.bottom, 12)
            }
            .scrollBounceBehavior(.basedOnSize)

            footer
                .padding(.horizontal, 36)
                .padding(.vertical, 20)
        }
        .frame(width: 600, height: 600)
        .task {
            await store.refreshAccounts()
            await store.refreshTools()
            if !choiceLoaded, let tools = store.tools {
                choice = tools.chosen ?? tools.detected ?? choice
                if !choice.any { choice.claudeVSCode = true }
                choiceLoaded = true
            }
            if let index = steps.firstIndex(of: startAt) { step = index }
        }
    }

    // MARK: Outils

    private var toolsStep: some View {
        VStack(alignment: .leading, spacing: 18) {
            header("square.grid.2x2", "Avec quoi travailles-tu ?",
                   "Coche ce que tu utilises : Vigie s'adapte. Il a déjà coché ce qu'il a trouvé sur ton Mac.")
            toolGroup("Claude Code", [
                (\ToolsChoice.claudeVSCode, "Dans VS Code", "L'extension Claude Code", store.tools?.detected?.claudeVSCode == true),
                (\ToolsChoice.claudeApp, "Dans l'app Claude", "L'onglet Code de l'app de bureau", store.tools?.detected?.claudeApp == true),
            ])
            toolGroup("Codex (OpenAI)", [
                (\ToolsChoice.codexVSCode, "Dans VS Code", "L'extension Codex", store.tools?.detected?.codexVSCode == true),
                (\ToolsChoice.codexApp, "Dans l'app ChatGPT", "Codex dans l'app de bureau", store.tools?.detected?.codexApp == true),
            ])
            Text("Tu peux en cocher plusieurs : Vigie suit tes conversations où qu'elles soient.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    private func toolGroup(_ title: String, _ rows: [(WritableKeyPath<ToolsChoice, Bool>, String, String, Bool)]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline)
            VStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    Toggle(isOn: Binding(get: { choice[keyPath: row.0] }, set: { choice[keyPath: row.0] = $0 })) {
                        HStack {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(row.1)
                                Text(row.2).font(.callout).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if row.3 {
                                Label("Trouvé sur ton Mac", systemImage: "checkmark.circle")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .toggleStyle(.checkbox)
                    .padding(12)
                    if index < rows.count - 1 { Divider() }
                }
            }
            .background(.quinary, in: .rect(cornerRadius: Theme.corner))
        }
    }

    // MARK: Codex

    private var codexAccount: Account? { store.accounts.first(where: \.isCodex) }
    private var codexReady: Bool { codexAccount?.isConnected == true && codexAccount?.hook?.trusted == true }

    private var codexStep: some View {
        VStack(alignment: .leading, spacing: 18) {
            header("chevron.left.forwardslash.chevron.right", "Codex",
                   "Deux choses à faire une seule fois. Sans elles, Vigie ne peut rien accepter pour Codex.")
            if codexAccount == nil {
                Label("Codex n'a pas encore été ouvert sur ce Mac : ouvre-le une fois, puis reviens ici.", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(Theme.warn)
            } else {
                CodexSetupSteps(account: codexAccount, tools: choice)
                    .padding(14)
                    .background(.quinary, in: .rect(cornerRadius: Theme.corner))
            }
            if codexSkipped && !codexReady {
                Label("Sans ces deux étapes, Codex n'est pas surveillé. Tu pourras les faire plus tard dans Comptes.", systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .foregroundStyle(Theme.warn)
            }
        }
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
        VStack(alignment: .leading, spacing: 20) {
            header("hand.raised.fill", "Les actions sensibles restent à toi",
                   "Même avec l'auto-accept, Vigie ne valide jamais ces actions à ta place.")
            FlowChips(items: ["Commande sudo", "Suppression de dossiers importants", "git push forcé", "Effacement de disque",
                              "Paiements et achats", "Envoi d'e-mails", "Publication sur les réseaux", "Réglages de Claude Code et du shell"])
            VStack(alignment: .leading, spacing: 10) {
                Text("Tu les autorises où tu veux").font(.headline)
                Label("Dans ta conversation : la fenêtre habituelle de Claude Code", systemImage: "bubble.left.and.text.bubble.right")
                Label("Dans Vigie, avec une notification : un clic suffit", systemImage: "binoculars")
                Text("Les deux restent d'accord : réponds d'un côté, l'autre se ferme. Avec Codex, c'est dans Vigie (Codex ne sait pas afficher sa fenêtre à la demande).")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
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
                   "Plusieurs abonnements Claude ? Ajoute-les : Vigie suit la consommation de chacun\(choice.claudeVSCode ? ", et tu choisis le compte de chaque conversation" : "").")
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
            Button("Ajouter un compte Claude", systemImage: "plus") { showAdd = true }
                .glassButton()
            // VS Code seulement : c'est ce lanceur qui choisit le compte de chaque conversation et coupe les MCP du
            // compte (même avec un seul compte). L'app Claude, elle, utilise le compte connecté dans l'app.
            if choice.claudeVSCode {
                Toggle(isOn: wrapperBinding) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Choisir le compte de chaque conversation (VS Code)")
                        Text("Vigie démarre tes conversations Claude dans VS Code avec le compte que tu choisis pour chacune. Recommandé, même avec un seul compte.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
                .toggleStyle(.switch)
            }
            if choice.claudeApp {
                Text("Dans l'app Claude, la conversation utilise le compte connecté dans l'app.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        .sheet(isPresented: $showAdd) { OnboardingAddAccountSheet() }
    }

    private var wrapperActive: Bool { store.accountsState?.wrapper?.active == true }
    private var wrapperBinding: Binding<Bool> {
        Binding(get: { wrapperActive }, set: { on in Task { await store.setWrapper(on) } })
    }

    // MARK: 4. MCP

    @State private var showLibrary = false

    private var mcps: some View {
        @Bindable var store = store
        let mcp = store.mcp
        let projectCount = ((mcp?.projects ?? []) + (mcp?.local ?? [])).reduce(0) { $0 + $1.servers.count }
        return VStack(alignment: .leading, spacing: 18) {
            header(Icon.mcp, "Tes MCP", "Les outils que Claude peut utiliser (Notion, Figma, ta base de données…). Il y en a trois sortes :")
            VStack(spacing: 0) {
                mcpFamily("desktopcomputer", "MCP de ce Mac", mcp.map { Fmt.count($0.user.count, "MCP", "MCP") },
                          "Dans toutes tes conversations, sur tous tes comptes Claude.")
                Divider()
                mcpFamily("folder", "MCP des projets", mcp.map { _ in Fmt.count(projectCount, "MCP", "MCP") },
                          "Seulement quand Claude travaille dans le dossier du projet (fichier .mcp.json).")
                Divider()
                VStack(alignment: .leading, spacing: 8) {
                    mcpFamily("person.crop.circle", "MCP du compte (claude.ai)", mcp.map { Fmt.count($0.connectors.count, "MCP", "MCP") },
                              "Branchés à ton compte sur claude.ai (Gmail, Drive…), partagés par toutes ses conversations.")
                    Toggle(isOn: $store.connectorsDefaultOn) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Les activer dans les nouvelles conversations")
                            Text("Coupés, ils n'encombrent pas Claude ; tu peux les allumer pour une conversation précise.")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .toggleStyle(.switch)
                    .padding(.horizontal, 12)
                    .padding(.bottom, wrapperActive || !choice.claudeVSCode ? 10 : 4)
                    // Sans le lanceur, Claude Code charge toujours les MCP du compte : on le dit, et on propose de l'activer.
                    if choice.claudeVSCode && !wrapperActive && !store.connectorsDefaultOn {
                        HStack(spacing: 8) {
                            Label("Pour les couper, Vigie doit lancer tes conversations.", systemImage: "exclamationmark.triangle")
                                .font(.callout)
                                .foregroundStyle(Theme.warn)
                            Spacer()
                            Button("L'activer") { wrapperBinding.wrappedValue = true }
                                .glassButton(.primary)
                        }
                        .padding(.horizontal, 12)
                        .padding(.bottom, 10)
                    }
                }
            }
            .background(.quinary, in: .rect(cornerRadius: Theme.corner))
            HStack(spacing: 10) {
                Button("Ajouter des MCP officiels", systemImage: "books.vertical") { showLibrary = true }
                    .glassButton()
                Text("Tout se règle ensuite dans la page MCP.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        .sheet(isPresented: $showLibrary) { MCPLibrarySheet() }
        .task { if store.mcp == nil { await store.refreshMCP() } }
    }

    private func mcpFamily(_ symbol: String, _ title: String, _ count: String?, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(width: 26)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(title).font(.headline)
                    Spacer()
                    Text(count ?? "…").foregroundStyle(.secondary).monospacedDigit()
                }
                Text(text)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
    }

    // MARK: 5. C'est parti

    @State private var notificationsAsked = false

    private var ready: some View {
        @Bindable var store = store
        return VStack(alignment: .leading, spacing: 20) {
            header("checkmark.seal.fill", "C'est prêt", "Quelques réglages, modifiables à tout moment.")
            VStack(spacing: 0) {
                setting("Auto-accept", "Valide les demandes d'autorisation dans toutes tes conversations (sauf les actions sensibles).",
                        isOn: $store.autoAccept)
                Divider()
                setting("Répondre aux questions quand tu n'es pas là",
                        "Si Claude te pose une question et que tu ne réponds pas en \(store.questionWaitMin) min, il prend l'option recommandée. Tu relis ensuite dans Vigie.",
                        isOn: $store.questionsAuto)
                Divider()
                setting("Mises à jour automatiques",
                        "Vigie installe tout seul ses nouvelles versions et te montre ce qui a changé.",
                        isOn: $store.autoUpdate)
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
                ForEach(0..<steps.count, id: \.self) { index in
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
            if current == .codex && !codexReady {
                Button(codexSkipped ? "Passer quand même" : "Plus tard") {
                    if codexSkipped { withAnimation(.smooth) { step += 1 } } else { codexSkipped = true }
                }
                .glassButton()
                .help("Codex ne sera pas surveillé tant que ce n'est pas fait")
            }
            Button(step == steps.count - 1 ? "Commencer" : "Continuer") {
                if current == .tools { Task { await store.saveTools(choice) } }
                if step == steps.count - 1 {
                    done = true
                    dismiss()
                } else {
                    withAnimation(.smooth) { step += 1 }
                }
            }
            .keyboardShortcut(.defaultAction)
            .glassButton(.primary)
            // Codex : on n'avance qu'une fois connecté et ses hooks approuvés (ou par « Plus tard »)
            .disabled((current == .codex && !codexReady) || (current == .tools && !choice.any))
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
                AsyncButton("Connecter") { await store.connectAccount(account.id) }
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
