import SwiftUI

/// Comptes : une section par compte (jauges, reprise, relevé), compte par défaut, choix dans VS Code.
struct AccountsView: View {
    @Environment(VigieStore.self) private var store
    let highlight: String?

    @State private var showAddAccount = false
    @State private var showWrapperExplain = false

    var body: some View {
        @Bindable var store = store
        Group {
            if accounts.isEmpty && !store.loadedOnce {
                LoadingView()
            } else {
                ScrollViewReader { proxy in
                    Form {
                        ForEach(accounts) { account in
                            Section {
                                AccountCard(account: account, highlighted: account.id == highlight)
                            }
                            .id(account.id)
                        }

                        Section {
                            Picker(selection: $store.defaultAccountID) {
                                ForEach(accounts.filter { !$0.isCodex }) { account in
                                    Text(account.displayName).tag(account.id)
                                }
                            } label: {
                                Text("Compte des nouvelles conversations")
                            }
                            .pickerStyle(.menu)

                            Toggle(isOn: wrapperToggle) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Un compte par conversation dans VS Code")
                                    Text(wrapperActive ? "Chaque conversation garde son compte" : "Désactivé : VS Code utilise le compte principal")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .toggleStyle(.switch)
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
                AsyncButton("Actualiser les relevés", systemImage: "arrow.clockwise") { await store.refreshUsage(nil) }
                .help("Relever à nouveau les crédits de tous les comptes")
            }
            ToolbarItem {
                Button("Ajouter un compte", systemImage: "plus") { showAddAccount = true }
                    .help("Ajouter un compte")
            }
        }
        .sheet(isPresented: $showAddAccount) { AddAccountSheet() }
        .sheet(isPresented: $showWrapperExplain) { WrapperExplainSheet() }
        .task { await store.followAccounts() }
    }

    private var accounts: [Account] {
        store.accountsState?.accounts.isEmpty == false ? (store.accountsState?.accounts ?? []) : store.accounts
    }

    private var wrapperActive: Bool {
        store.accountsState?.wrapper?.active ?? store.engineInfo?.wrapperActive ?? false
    }

    /// Activer passe d'abord par une courte explication ; désactiver est immédiat.
    private var wrapperToggle: Binding<Bool> {
        Binding {
            wrapperActive
        } set: { enable in
            if enable {
                showWrapperExplain = true
            } else {
                Task { await store.setWrapper(false) }
            }
        }
    }

    private var subtitle: String {
        let connected = accounts.count(where: \.isConnected)
        return "\(connected) sur \(accounts.count) connectés"
    }

    private func scroll(_ proxy: ScrollViewProxy) {
        guard let highlight else { return }
        withAnimation(.smooth) { proxy.scrollTo(highlight, anchor: .top) }
    }
}

/// Un compte : nom, adresse en dessous, jauges, âge et source du relevé.
struct AccountCard: View {
    @Environment(VigieStore.self) private var store
    let account: Account
    let highlighted: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            // Codex : connexion puis approbation du hook, tant que ce n'est pas fait
            if account.isCodex && !(account.isConnected && account.hook?.trusted == true) {
                CodexSetupSteps(account: account)
            }
            if account.wrongAccount == true {
                Label {
                    let expected = Text(account.expectedEmail.map { " (prévu : \($0))" } ?? "").foregroundStyle(.secondary)
                    Text("Connecté avec une autre adresse que prévu\(expected)")
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                }
                .font(.callout)
                .foregroundStyle(.red)
            }
            if account.isConnected {
                let usage = account.usage
                VStack(spacing: 8) {
                    if !account.isCodex || usage?.session != nil {
                        UsageGaugeRow(title: "Session 5 h", window: usage?.session)
                    }
                    UsageGaugeRow(title: "Semaine", window: usage?.week)
                    if let model = usage?.weekModel {
                        UsageGaugeRow(title: "Semaine \(model.label ?? "modèle")", window: model)
                    }
                }
                footer
            } else if !account.isCodex {
                Text("Connecte-le pour voir ses crédits.")
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    private var header: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text(account.displayName)
                    .font(.title3.bold())
                Text(account.isCodex ? "Codex (OpenAI) · ton compte ChatGPT\(account.plan.map { " · forfait \($0)" } ?? "")"
                     : account.email ?? account.expectedEmail ?? "Adresse inconnue")
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if account.isDefault == true || store.accountsState?.defaultForNew == account.id {
                Text("Nouvelles conversations")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .help("Compte des nouvelles conversations")
            }
            if account.isConnected {
                Label("Connecté", systemImage: "checkmark.circle")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else if account.isCodex {
                EmptyView()
            } else {
                AsyncButton("Connecter", systemImage: "person.crop.circle.badge.plus") { await store.connectAccount(account.id) }
                .glassButton(.primary)
                .help("Ouvre Terminal pour te connecter (/login)")
            }
        }
    }

    /// « Relevé il y a 12 min, par une conversation » et « Actualiser » quand il manque ou vieillit.
    private var footer: some View {
        let usage = account.usage
        let observed = usage?.observedAt
        let missing = usage?.session?.pct == nil || usage?.week?.pct == nil
        let old = observed.map { store.now.timeIntervalSince($0) > 3600 } ?? true
        return HStack(spacing: 10) {
            Text(observedText(observed, source: usage?.source))
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            if (missing || old) && !account.isCodex {
                AsyncButton("Actualiser", systemImage: "arrow.clockwise") { await store.refreshUsage(account.id) }
                .glassButton()
                .controlSize(.small)
                .help("Relever les crédits de ce compte (une petite requête, au plus toutes les 10 min)")
            }
        }
    }

    private func observedText(_ observed: Date?, source: String?) -> String {
        guard let observed else { return "Pas encore de relevé" }
        let origin: String = switch source {
        case "session": account.isCodex ? ", par une conversation Codex" : ", par une conversation"
        case "ping": ", par une requête rapide"
        default: ""
        }
        return "Relevé \(Fmt.ago(observed, now: store.now))\(origin)"
    }
}

/// Une jauge : « Semaine   ▬▬▬▬▭▭   39 %   reprise lun. 26 oct. à 20:00 » ; « — » sans relevé.
struct UsageGaugeRow: View {
    @Environment(VigieStore.self) private var store
    let title: String
    let window: UsageWindow?

    var body: some View {
        let pct = window?.pct
        HStack(spacing: 14) {
            Text(title)
                .frame(width: 118, alignment: .leading)
            UsageBar(pct: pct, height: 6)
            Text(pct.map(Fmt.pct) ?? "—")
                .bold()
                .monospacedDigit()
                .foregroundStyle(pct == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                .frame(width: 52, alignment: .trailing)
            Text(resetText)
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(width: 210, alignment: .leading)
                .lineLimit(1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title) : \(pct.map(Fmt.pct) ?? "pas de relevé"), \(resetText)")
    }

    private var resetText: String {
        guard window?.pct != nil else { return "pas de relevé récent" }
        guard let date = window?.resetsAt else { return "" }
        if date < store.now { return "remis à zéro" }
        return "reprise \(Fmt.reset(date, now: store.now))"
    }
}

extension VigieStore {
    /// Compte des nouvelles conversations (lié au sélecteur).
    var defaultAccountID: String {
        get {
            accountsState?.defaultForNew ?? accounts.first(where: { $0.isDefault == true })?.id ?? accounts.first?.id ?? ""
        }
        set {
            Task { await setDefaultAccount(newValue) }
        }
    }
}
