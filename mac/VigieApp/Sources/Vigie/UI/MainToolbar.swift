import SwiftUI

/// Barre d'outils de la fenêtre : Retour / Suivant en tête ; à droite, « 3 à décider » en rouge (absent quand rien ne
/// t'attend), puis les réglages de toute l'app : Garde-fous, Questions (son état écrit en clair) et l'interrupteur
/// Auto-accept (contrôle principal).
struct MainToolbar: ToolbarContent {
    @Bindable var store: VigieStore

    var body: some ToolbarContent {
        ToolbarItemGroup(placement: .navigation) {
            Button {
                store.goBack()
            } label: {
                Label("Retour", systemImage: "chevron.backward")
            }
            .disabled(!store.canGoBack)
            .help("Page précédente (⌘[)")
            Button {
                store.goForward()
            } label: {
                Label("Suivant", systemImage: "chevron.forward")
            }
            .disabled(!store.canGoForward)
            .help("Page suivante (⌘])")
        }
        if store.decisionCount > 0 {
            ToolbarItem(placement: .primaryAction) {
                DecisionsButton(store: store)
            }
        }
        ToolbarItem(placement: .primaryAction) {
            GuardsButton(store: store)
        }
        ToolbarItem(placement: .primaryAction) {
            QuestionsMenu(store: store)
        }
        ToolbarItem(placement: .primaryAction) {
            AutoAcceptSwitch(store: store)
        }
    }
}

struct AutoAcceptSwitch: View {
    @Bindable var store: VigieStore

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: store.autoAccept ? "binoculars.fill" : "binoculars")
                .foregroundStyle(.secondary)
                .contentTransition(.symbolEffect(.replace))
            Text("Auto-accept")
            Toggle("Auto-accept", isOn: $store.autoAccept)
                .toggleStyle(.switch)
                .labelsHidden()
                .controlSize(.small)
        }
        .padding(.horizontal, 10)
        .help(store.autoAccept ? "Vigie accepte pour toi, sauf les actions sensibles" : "Claude te demande à chaque fois")
        .accessibilityElement(children: .combine)
    }
}

/// Le menu des questions : son état écrit dans la barre (« Questions : auto », « Questions : à toi »), pas seulement
/// une bulle « ? » qui se lirait « Aide ».
struct QuestionsMenu: View {
    @Bindable var store: VigieStore

    var body: some View {
        Menu {
            Toggle("Quand tu n'es pas là, Vigie choisit l'option recommandée", isOn: $store.questionsAuto)
            Picker("Attendre avant de choisir", selection: $store.questionWaitMin) {
                ForEach([5, 10, 20, 30, 60], id: \.self) { minutes in
                    Text("\(minutes) min").tag(minutes)
                }
            }
            .disabled(!store.questionsAuto)
        } label: {
            // une image et un texte, comme Garde-fous : un Label dans une barre d'outils n'y garde que son icône
            HStack(spacing: 6) {
                Image(systemName: store.questionsAuto ? "questionmark.bubble.fill" : "questionmark.bubble")
                Text(store.questionsAuto ? "Questions : auto" : "Questions : à toi")
            }
            .fixedSize()
        }
        .accessibilityLabel(store.questionsAuto ? "Questions : Vigie choisit pour toi" : "Questions : c'est toi qui réponds")
        .help(store.questionsAuto
              ? "Sans réponse de ta part, Vigie choisit l'option recommandée au bout de \(store.questionWaitMin) min"
              : "Les questions de Claude t'attendent : Vigie ne choisit pas à ta place")
    }
}

/// Ouvre les réglages des garde-fous (où décider des actions sensibles, règles).
struct GuardsButton: View {
    @Bindable var store: VigieStore
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        Button {
            store.settingsTab = .guards
            openSettings()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: Icon.guardRule)
                Text("Garde-fous")
            }
        }
        .help("Actions sensibles : à autoriser dans ta conversation ou dans Vigie")
    }
}

/// « 3 à décider » : en rouge tant qu'une décision t'attend, sur toutes les pages. Ouvre la liste des décisions ;
/// « Voir » mène à la conversation et à sa fiche. Rien ne se décide ici : Autoriser reste un clic, devant la commande.
struct DecisionsButton: View {
    @Bindable var store: VigieStore
    @State private var showList = false

    var body: some View {
        let count = store.decisionCount
        Button {
            showList.toggle()
        } label: {
            Text("\(Fmt.int(count)) à décider")
                .monospacedDigit()
                .fixedSize()
        }
        .glassButton(.primary)
        .tint(Theme.alert)
        .help(count > 1 ? "\(count) décisions t'attendent : la liste" : "Une décision t'attend")
        .accessibilityLabel("\(count) à décider")
        .popover(isPresented: $showList, arrowEdge: .bottom) {
            DecisionsList(store: store) { showList = false }
                .environment(store)
        }
    }
}

/// La liste du bouton « N à décider » : chaque décision (le délai d'abord) et « Voir ». Navigation seulement.
struct DecisionsList: View {
    let store: VigieStore
    let close: () -> Void

    /// Au-delà, « et N autres » ouvre la Vue d'ensemble.
    private static let shown = 8

    var body: some View {
        let items = store.decisionItems
        VStack(alignment: .leading, spacing: 10) {
            CardTitle("À décider", trailing: Fmt.int(items.count))
            ForEach(items.prefix(Self.shown)) { item in
                HStack(spacing: 10) {
                    DecisionSummary(item: item)
                    Button("Voir") { see(item) }
                        .glassButton()
                        .controlSize(.small)
                        .fixedSize()
                        .help("Ouvrir sa conversation et sa fiche")
                }
            }
            if items.count > Self.shown {
                Button("et \(items.count - Self.shown) autres") {
                    close()
                    store.route = .overview
                }
                .buttonStyle(.link)
                .font(.callout)
            }
        }
        .padding(14)
        .frame(width: 400)
    }

    /// La liste se ferme d'abord : la fiche s'ouvre ensuite sur la fenêtre, pas sous le popover.
    private func see(_ item: ReviewItem) {
        close()
        Task { @MainActor in store.open(review: item) }
    }
}
