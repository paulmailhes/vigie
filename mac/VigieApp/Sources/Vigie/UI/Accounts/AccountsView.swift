import SwiftUI

/// Comptes : le compte des nouvelles conversations en tête, puis une section par compte (ceux qui ont un problème
/// d'abord : jauges, remise à zéro, fraîcheur), puis la consommation de chaque conversation (graphique).
struct AccountsView: View {
    @Environment(VigieStore.self) private var store
    let highlight: String?

    @State private var showAddAccount = false

    var body: some View {
        @Bindable var store = store
        Group {
            if accounts.isEmpty && !store.loadedOnce {
                LoadingView()
            } else {
                ScrollViewReader { proxy in
                    Form {
                        // En tête : le compte sur lequel part chaque nouvelle conversation (on ne le voyait pas en bas)
                        Section {
                            DefaultAccountChoice(accounts: accounts.filter { !$0.isCodex })

                            // Toujours actif (le moteur s'en charge) : on ne le montre que s'il n'a pas pu l'être.
                            if !wrapperActive && store.tools?.chosen?.claudeVSCode != false && store.engineInfo != nil {
                                WrapperWarning()
                            }
                        }

                        ForEach(Self.ordered(accounts)) { account in
                            Section {
                                AccountCard(account: account, highlighted: account.id == highlight)
                            }
                            .id(account.id)
                        }

                        // La consommation de chaque conversation : de l'analyse, rangée ici plutôt que dans la vue
                        // d'ensemble. Posée en en-tête d'une section vide : le graphique a son propre cadre, sans la
                        // carte du Form autour.
                        Section {
                        } header: {
                            UsageSection()
                                .font(.body)
                                .foregroundStyle(.primary)
                                .textCase(nil)
                                // l'en-tête d'une section du Form est en retrait de 10 pt sur ses cartes
                                .padding(.horizontal, -10)
                        }
                    }
                    .pageForm()
                    .onAppear { scroll(proxy) }
                    .onChange(of: highlight) { scroll(proxy) }
                }
            }
        }
        .navigationTitle("Comptes")
        .navigationSubtitle(subtitle)
        .toolbar {
            ToolbarItem {
                AsyncButton("Actualiser la consommation", systemImage: "arrow.clockwise") { await store.refreshUsage(nil) }
                    .help("Relire la consommation de tous les comptes")
            }
            ToolbarItem {
                Button("Ajouter un compte", systemImage: "plus") { showAddAccount = true }
                    .labelStyle(.titleAndIcon)
                    .help("Un nom, puis la connexion dans ton navigateur")
            }
        }
        .sheet(isPresented: $showAddAccount) { OnboardingAddAccountSheet() }
        .task(id: store.windowVisible) { await store.followAccounts() }
    }

    private var accounts: [Account] {
        store.accountsState?.accounts.isEmpty == false ? (store.accountsState?.accounts ?? []) : store.accounts
    }

    private var wrapperActive: Bool {
        store.accountsState?.wrapper?.active ?? store.engineInfo?.wrapperActive ?? false
    }

    /// « 2 connectés sur 3 · 1 à régler ».
    private var subtitle: String {
        let connected = accounts.count(where: \.isConnected)
        let issues = accounts.count(where: AccountCard.hasProblem)
        return InfoLine.text(["\(connected) connecté\(connected > 1 ? "s" : "") sur \(accounts.count)",
                              issues > 0 ? "\(issues) à régler" : nil])
    }

    /// Les comptes qui ont un problème (mauvaise adresse, doublon, pas connecté) d'abord, les autres ensuite ; l'ordre
    /// du moteur est gardé dans chaque groupe.
    nonisolated static func ordered(_ accounts: [Account]) -> [Account] {
        accounts.filter(AccountCard.hasProblem) + accounts.filter { !AccountCard.hasProblem($0) }
    }

    private func scroll(_ proxy: ScrollViewProxy) {
        guard let highlight else { return }
        withAnimation(.smooth) { proxy.scrollTo(highlight, anchor: .top) }
    }
}

/// Le choix du compte par conversation n'a pas pu être activé dans VS Code : ce que ça change, et « Activer ».
private struct WrapperWarning: View {
    @Environment(VigieStore.self) private var store

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.warn)
                .frame(width: 30)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("Le choix du compte par conversation n'est pas actif dans VS Code")
                Text("Sans ça, toutes tes conversations VS Code partent sur le compte de ton Mac.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            AsyncButton("Activer") { await store.setWrapper(true) }
                .glassButton()
        }
    }
}

/// Un compte : nom, adresse et état, jauges, fraîcheur de la consommation.
struct AccountCard: View {
    @Environment(VigieStore.self) private var store
    let account: Account
    @State private var confirmRemove = false
    let highlighted: Bool

    /// Mauvaise adresse, doublon d'un autre compte, ou compte Claude pas connecté : à régler avant tout.
    nonisolated static func hasProblem(_ account: Account) -> Bool {
        account.wrongAccount == true || account.sameAs?.isEmpty == false || (!account.isConnected && !account.isCodex)
    }

    /// L'adresse à montrer sous le nom : la vraie adresse connectée ; si elle n'est pas la bonne et qu'on ne la
    /// connaît pas, « adresse différente » (jamais l'adresse prévue, qui contredirait l'alerte).
    nonisolated static func address(_ account: Account) -> String? {
        if account.wrongAccount == true { return foundEmail(account) ?? "Adresse différente de celle prévue" }
        return account.email ?? account.expectedEmail
    }

    /// L'adresse réellement connectée d'un compte à la mauvaise adresse ; nil si on ne la connaît pas (ou si elle
    /// n'est que l'adresse prévue recopiée).
    private nonisolated static func foundEmail(_ account: Account) -> String? {
        guard let email = account.email, !email.isEmpty else { return nil }
        if let expected = account.expectedEmail, email.caseInsensitiveCompare(expected) == .orderedSame { return nil }
        return email
    }

    /// « Connecté avec bob@autre.fr. Adresse prévue : alex.durand@gmail.com. » (sans « au lieu de », qui demanderait
    /// une élision devant une voyelle).
    nonisolated static func wrongAddressText(_ account: Account) -> String {
        switch (foundEmail(account), account.expectedEmail) {
        case let (found?, expected?): "Connecté avec \(found). Adresse prévue : \(expected)."
        case let (found?, nil): "Connecté avec \(found), pas avec l'adresse prévue."
        case let (nil, expected?): "Connecté avec une autre adresse que \(expected)."
        case (nil, nil): "Connecté avec une autre adresse que celle prévue."
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            // Codex : connexion puis approbation du hook, tant que ce n'est pas fait
            if account.isCodex && !(account.isConnected && account.hook?.trusted == true) {
                CodexSetupSteps(account: account, polls: false)
            }
            if account.wrongAccount == true {
                problem(Self.wrongAddressText(account),
                        then: "Sur claude.ai, connecte-toi avec \(account.expectedEmail ?? "la bonne adresse") (ou déconnecte-toi), puis :")
            } else if let same = account.sameAs, !same.isEmpty {
                let names = same.map { id in store.accounts.first(where: { $0.id == id })?.displayName ?? id }
                    .formatted(.list(type: .and).locale(Fmt.locale))
                problem("Même compte Claude que \(names) : au moment de la connexion, ton navigateur était connecté à ce compte-là.",
                        then: "Sur claude.ai, passe sur le bon compte (ou déconnecte-toi), puis :")
            }
            if account.isConnected {
                let usage = account.usage
                VStack(spacing: 8) {
                    if !account.isCodex || usage?.session != nil {
                        UsageGaugeRow(title: "Session 5 h", window: usage?.session)
                    }
                    // la remise à zéro est écrite juste à côté de la jauge : la prévision ne la répète pas
                    UsageGaugeRow(title: "Semaine", window: usage?.week,
                                  forecast: WeekForecast.text(usage?.week, now: store.now, withReset: false))
                    if let model = usage?.weekModel {
                        UsageGaugeRow(title: "Semaine \(model.label ?? "modèle")", window: model)
                    }
                }
                footer
            } else if !account.isCodex {
                Text("Connecte-le pour voir sa consommation.")
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    /// Un compte mal connecté : ce qui ne va pas (l'icône en rouge, la phrase lisible), ce qu'il faut faire, et
    /// « Reconnecter » (la connexion reprend le compte ouvert dans le navigateur).
    private func problem(_ text: String, then: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label {
                Text(text)
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Theme.alert)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) {
                    Text(then)
                        .foregroundStyle(.secondary)
                    reconnectButton
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text(then)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    reconnectButton
                }
            }
        }
        .font(.callout)
    }

    private var reconnectButton: some View {
        AsyncButton("Reconnecter", systemImage: "arrow.clockwise") { await store.connectAccount(account.id) }
            .glassButton(.primary)
            .controlSize(.small)
            .help("Ouvre la page de connexion de Claude dans ton navigateur")
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(account.displayName)
                    .font(.headline)
                Text(account.isCodex ? InfoLine.text(["Codex (OpenAI)", "ton compte ChatGPT", account.plan.map { "forfait \($0)" }])
                     : Self.address(account) ?? "Adresse inconnue")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if account.isDefault == true || store.accountsState?.defaultForNew == account.id {
                Chip("Par défaut")
                    .help("Les nouvelles conversations partent sur ce compte")
            }
            if account.wrongAccount == true {
                Chip("Mauvaise adresse", symbol: "exclamationmark.triangle.fill", tone: .alert)
            } else if account.sameAs?.isEmpty == false {
                Chip("En double", symbol: "exclamationmark.triangle.fill", tone: .alert)
            } else if account.isConnected {
                Chip("Connecté", symbol: "checkmark")
            } else if !account.isCodex {
                AsyncButton("Connecter", systemImage: "person.crop.circle.badge.plus") { await store.connectAccount(account.id) }
                    .glassButton(.primary)
                    .help("Ouvre la page de connexion de Claude dans ton navigateur")
            }
            // un compte ajouté (pas celui du Mac, ni Codex) : le supprimer
            if account.configDir != nil && !account.isCodex {
                MoreMenu(name: account.displayName) {
                    Button("Supprimer le compte…", systemImage: "trash", role: .destructive) { confirmRemove = true }
                }
            }
        }
        .confirmationDialog("Supprimer « \(account.displayName) » de Vigie ?", isPresented: $confirmRemove) {
            Button("Supprimer", role: .destructive) { Task { await store.removeAccount(account.id) } }
        } message: {
            Text("Il est déconnecté de Claude Code sur ce Mac ; son dossier est mis de côté (rien n'est effacé) ; ses conversations passent sur le compte par défaut. Ton abonnement Claude n'est pas touché.")
        }
    }

    /// « Mis à jour il y a 12 min · 01:18 · lu dans une conversation », et « Actualiser » quand il manque ou vieillit.
    private var footer: some View {
        let usage = account.usage
        let observed = usage?.observedAt
        let missing = usage?.session?.pct == nil || usage?.week?.pct == nil
        let old = observed.map { store.now.timeIntervalSince($0) > 3600 } ?? true
        return HStack(spacing: 10) {
            if let observed {
                InfoLine(parts: [Freshness.text(prefix: "Mis à jour", date: observed, now: store.now), origin(usage?.source)])
            } else {
                Text("Consommation pas encore lue")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if (missing || old) && !account.isCodex {
                AsyncButton("Actualiser", systemImage: "arrow.clockwise") { await store.refreshUsage(account.id) }
                    .glassButton()
                    .controlSize(.small)
                    .help("Relire la consommation de ce compte")
            }
        }
    }

    private func origin(_ source: String?) -> String? {
        switch source {
        case "session": account.isCodex ? "lu dans une conversation Codex" : "lu dans une conversation"
        case "ping": "lu par Vigie"
        default: nil
        }
    }
}

/// Une jauge : « Semaine   ▬▬▬▬▭▭   39 %   remise à zéro lun. 26 oct. à 20:00 » ; « — » sans chiffre récent. Sous la
/// jauge Semaine, quand le moteur la voit pleine avant la remise à zéro : « À ce rythme : semaine pleine vers jeu. 14 h »
/// (`WeekForecast`, sans redire la remise à zéro écrite juste au-dessus), en gris avec un triangle orange.
struct UsageGaugeRow: View {
    @Environment(VigieStore.self) private var store
    let title: String
    let window: UsageWindow?
    var forecast: String? = nil

    /// Largeur du titre et écart : la phrase de prévision commence sous la barre.
    private static let titleWidth: CGFloat = 118
    private static let spacing: CGFloat = 14

    var body: some View {
        let pct = window?.pct
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: Self.spacing) {
                Text(title)
                    .frame(width: Self.titleWidth, alignment: .leading)
                UsageBar(pct: pct, height: 6)
                Text(Fmt.pct(pct))
                    .bold()
                    .monospacedDigit()
                    .foregroundStyle(pct == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                    .frame(width: 52, alignment: .trailing)
                Text(resetText)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(width: 240, alignment: .leading)
                    .lineLimit(1)
            }
            if let forecast {
                // une phrase : en gris, l'icône orange seule signale (la couleur est pour les mots courts)
                Label {
                    Text(forecast)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Theme.warn)
                }
                .labelStyle(CompactLabelStyle())
                .font(.callout)
                .padding(.leading, Self.titleWidth + Self.spacing)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(InfoLine.text(["\(title) : \(pct.map(Fmt.pct) ?? "pas de chiffre récent"), \(resetText)", forecast]))
    }

    private var resetText: String {
        guard window?.pct != nil else { return "pas de chiffre récent" }
        guard let date = window?.resetsAt else { return "" }
        if date < store.now { return "remis à zéro" }
        return "remise à zéro \(Fmt.reset(date, now: store.now))"
    }
}

extension VigieStore {
    /// Compte des nouvelles conversations, tel que le moteur le connaît.
    var defaultAccountID: String {
        accountsState?.defaultForNew ?? accounts.first(where: { $0.isDefault == true })?.id ?? accounts.first?.id ?? ""
    }
}

/// Le compte des nouvelles conversations, en tête de la page : bien visible, expliqué, et changé seulement par un clic
/// dans son menu (un sélecteur lié pouvait se réécrire tout seul quand la liste des comptes se rechargeait).
struct DefaultAccountChoice: View {
    @Environment(VigieStore.self) private var store
    let accounts: [Account]

    var body: some View {
        let current = store.defaultAccountID
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: "plus.bubble.fill")
                .font(.title2)
                .foregroundStyle(Theme.action)
                .frame(width: 30)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("Compte des nouvelles conversations")
                    .font(.headline)
                Text("Chaque nouvelle conversation part sur ce compte. Une conversation déjà commencée garde le sien : change-le depuis la conversation.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
            Menu {
                ForEach(accounts) { account in
                    Button {
                        guard account.id != current else { return }
                        Task { await store.setDefaultAccount(account.id) }
                    } label: {
                        if account.id == current {
                            Label(account.displayName, systemImage: "checkmark")
                        } else {
                            Text(account.displayName)
                        }
                    }
                }
            } label: {
                Text(accounts.first(where: { $0.id == current })?.displayName ?? "Choisir")
                    .fontWeight(.semibold)
            }
            .menuStyle(.button)
            .fixedSize()
            .help("Le compte sur lequel partent les nouvelles conversations")
        }
        .padding(.vertical, 6)
    }
}
