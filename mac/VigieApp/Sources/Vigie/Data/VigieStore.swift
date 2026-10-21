import Foundation
import Observation

/// Toutes les données affichées, rafraîchies par sondage du moteur, et l'état de navigation.
/// Chaque partie n'est remplacée que si elle a changé : pas de clignotement, pas de perte de sélection.
@MainActor
@Observable
final class VigieStore {
    static let shared = VigieStore(client: .fromEnvironment())

    let client: VigieClient
    var isDemo: Bool { client.isDemo }

    // MARK: Données du moteur

    private(set) var settings: EngineSettings?
    /// Heure du moteur (sert d'horloge en démonstration, pour des âges stables).
    private(set) var engineNow: Date?
    private(set) var since: Date?
    private(set) var sinceSummary: SinceSummary?
    private(set) var toReview: [ReviewItem] = []
    /// Éléments que l'utilisateur vient de traiter : retirés tout de suite, et pas remis par une lecture partie
    /// avant son clic (l'utilisateur : « faire l'action, revenir en arrière si ça n'a pas marché »).
    private var settledReview: [String: Date] = [:]
    private(set) var reports: [Row<Report>] = []
    private(set) var accounts: [Account] = []
    private(set) var conversations: [ConversationSummary] = []

    static func stableOrder(_ list: [ConversationSummary]) -> [ConversationSummary] {
        let open = list.filter(\.isOpen).sorted {
            let c = $0.shortTitle.localizedStandardCompare($1.shortTitle)
            return c == .orderedSame ? $0.id < $1.id : c == .orderedAscending
        }
        let closed = list.filter { !$0.isOpen }
        return open + closed
    }
    /// Fil des dernières acceptations envoyé par le moteur (vide s'il ne le fournit pas encore).
    private(set) var recentAccepted: [RecentAccepted] = []
    private(set) var engineInfo: EngineInfo?
    private(set) var details: [String: ConversationDetailModel] = [:]
    private(set) var mcp: MCPState?
    private(set) var accountsState: AccountsState?
    /// Graphique de consommation, par fenêtre (60, 600, 1200 min).
    private(set) var usageSeries: [Int: UsageSeries] = [:]
    /// Le moteur ne fournit pas (encore) GET /api/v2/usage/series.
    private(set) var usageUnavailable = false
    private(set) var connection: Connection = .connecting
    private(set) var loadedOnce = false

    /// « Maintenant » pour les âges (« il y a 12 min ») : l'heure du moteur en démonstration.
    var now: Date { isDemo ? (engineNow ?? .now) : .now }

    // MARK: Interface

    var route: Route? = .overview
    var conversationTab: ConversationTab = .fil
    /// L'accueil (premier lancement, ou menu « Revoir l'accueil »).
    var showOnboarding = false
    /// Question en attente à laquelle répondre depuis Vigie.
    var answerRequest: ReviewItem?
    var changeRequest: ReviewItem?
    /// Fiche d'une action sensible (« Voir » sur une action bloquée).
    var blockedRequest: ReviewItem?
    /// Vérification des MCP lancée à l'instant (indicateur dans la barre d'outils).
    var mcpChecking = false
    /// Demande d'amener les onglets de la conversation en haut (« Voir » d'une action bloquée).
    var focusTabs = false
    var toast: Toast?
    /// Onglet affiché dans la fenêtre Réglages.
    var settingsTab: SettingsTab = .guards
    private(set) var restarting = false

    @ObservationIgnored var openMainWindow: (() -> Void)?
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var writesInFlight = 0
    @ObservationIgnored private var lastWriteEnd: ContinuousClock.Instant?
    @ObservationIgnored private var lastReadError: String?

    init(client: VigieClient) {
        self.client = client
    }

    // MARK: Sondage

    /// Démarre le sondage de la vue d'ensemble (toutes les 3 s ; une seule lecture en démonstration).
    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refreshOverview()
                if self.isDemo && self.loadedOnce { return }
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    func refreshOverview() async {
        let started = ContinuousClock.now
        do {
            let overview = try await client.get("/api/v2/overview", as: Overview.self)
            guard isFresh(started) else { return }
            apply(overview)
            readSucceeded()
            Notifier.shared.process(self)
        } catch {
            readFailed(error)
        }
    }

    /// Suit une conversation affichée (toutes les 4 s), jusqu'à ce que la vue disparaisse.
    func follow(conversation id: String) async {
        while !Task.isCancelled {
            await refreshConversation(id)
            if isDemo { return }
            try? await Task.sleep(for: .seconds(4))
        }
    }

    func refreshConversation(_ id: String) async {
        if isDemo, details[id] != nil { return }
        let started = ContinuousClock.now
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        do {
            let detail = try await client.get("/api/v2/conversation/\(encoded)", as: ConversationDetail.self)
            guard isFresh(started) else { return }
            if details[id]?.raw != detail {
                details[id] = ConversationDetailModel(detail)
            }
            readSucceeded()
        } catch {
            readFailed(error)
        }
    }

    /// Complète les cartes de la vue d'ensemble quand le moteur ne fournit pas encore leurs champs
    /// (avancement, tests, acceptations, artefacts, fil) : lit le détail des conversations ouvertes, toutes les 30 s.
    func followCardDetails() async {
        while !Task.isCancelled {
            let feedMissing = recentAccepted.isEmpty
            for conversation in conversations where conversation.isOpen {
                let complete = conversation.progress != nil && conversation.tests != nil
                    && conversation.accepted != nil && conversation.artifacts != nil
                if complete && !feedMissing { continue }
                if Task.isCancelled { return }
                await refreshCardDetail(conversation.id)
            }
            if isDemo { return }
            try? await Task.sleep(for: .seconds(30))
        }
    }

    /// Lecture discrète d'un détail pour une carte : une erreur ne s'affiche pas.
    private func refreshCardDetail(_ id: String) async {
        if isDemo, details[id] != nil { return }
        let started = ContinuousClock.now
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        guard let detail = try? await client.get("/api/v2/conversation/\(encoded)", as: ConversationDetail.self),
              isFresh(started) else { return }
        if details[id]?.raw != detail {
            details[id] = ConversationDetailModel(detail)
        }
    }

    /// Suit le graphique de consommation affiché (toutes les 30 s).
    func followUsage(_ span: UsageSpan) async {
        while !Task.isCancelled {
            await refreshUsageSeries(span)
            if isDemo { return }
            try? await Task.sleep(for: .seconds(30))
        }
    }

    /// Lecture discrète : une erreur n'affiche rien, le bloc dit seulement qu'il n'a pas de données.
    func refreshUsageSeries(_ span: UsageSpan) async {
        if isDemo, usageSeries[span.rawValue] != nil { return }
        do {
            let series = try await client.get("/api/v2/usage/series?window=\(span.rawValue)", as: UsageSeries.self)
            if usageSeries[span.rawValue] != series { usageSeries[span.rawValue] = series }
            update(\.usageUnavailable, false)
        } catch {
            if usageSeries[span.rawValue] == nil { update(\.usageUnavailable, true) }
        }
    }

    func followMCP() async {
        while !Task.isCancelled {
            await refreshMCP()
            if isDemo { return }
            try? await Task.sleep(for: .seconds(5))
        }
    }

    func refreshMCP() async {
        if isDemo, mcp != nil { return }
        let started = ContinuousClock.now
        do {
            let state = try await client.get("/api/v2/mcp", as: MCPState.self)
            guard isFresh(started) else { return }
            update(\.mcp, state)
            readSucceeded()
        } catch {
            readFailed(error)
        }
    }

    func followAccounts() async {
        while !Task.isCancelled {
            await refreshAccounts()
            if isDemo { return }
            try? await Task.sleep(for: .seconds(4))
        }
    }

    func refreshAccounts() async {
        if isDemo, accountsState != nil { return }
        let started = ContinuousClock.now
        do {
            let state = try await client.get("/api/v2/accounts", as: AccountsState.self)
            guard isFresh(started) else { return }
            update(\.accountsState, state)
            readSucceeded()
        } catch {
            readFailed(error)
        }
    }

    // MARK: Application des données

    private func apply(_ overview: Overview) {
        if isDemo { update(\.engineNow, overview.now) }
        update(\.settings, overview.settings)
        update(\.since, overview.since)
        update(\.sinceSummary, overview.sinceSummary)
        settledReview = settledReview.filter { Date.now.timeIntervalSince($0.value) < 15 }
        update(\.toReview, overview.toReview.filter { settledReview[$0.id] == nil })
        update(\.reports, RowIDs.make(overview.reports) { $0.stableKey })
        update(\.accounts, overview.accounts)
        // Ordre STABLE (L'utilisateur : « les conversations passent les unes devant les autres ») : ouvertes d'abord,
        // puis par nom de projet ; les fermées de la plus récente à la plus ancienne. L'activité ne déplace plus rien.
        update(\.conversations, Self.stableOrder(overview.conversations))
        update(\.recentAccepted, overview.recentAccepted)
        update(\.engineInfo, overview.engine)
        update(\.loadedOnce, true)
    }

    private func update<Value: Equatable>(_ keyPath: ReferenceWritableKeyPath<VigieStore, Value>, _ value: Value) {
        if self[keyPath: keyPath] != value {
            self[keyPath: keyPath] = value
        }
    }

    /// Une lecture partie avant ou pendant une écriture risque de remettre l'ancien état à l'écran.
    private func isFresh(_ started: ContinuousClock.Instant) -> Bool {
        if writesInFlight > 0 { return false }
        if let end = lastWriteEnd, end > started { return false }
        return true
    }

    private func readSucceeded() {
        update(\.connection, .ok)
        lastReadError = nil
    }

    private func readFailed(_ error: any Error) {
        let clientError = error as? ClientError ?? .unreadable
        switch clientError {
        case .unreachable:
            update(\.connection, .down)
        case .refused(let text):
            update(\.connection, .failing(text))
        case .unreadable, .missingFixture:
            if lastReadError != clientError.message {
                lastReadError = clientError.message
                show(error: clientError.message)
            }
        }
    }

    // MARK: Écritures

    /// POST vers le moteur. Les erreurs s'affichent en une ligne (sauf `quiet`) ; renvoie nil en cas d'échec.
    @discardableResult
    func write(_ path: String, _ body: JSONValue, quiet: Bool = false) async -> WriteResult? {
        writesInFlight += 1
        defer {
            writesInFlight -= 1
            lastWriteEnd = .now
        }
        do {
            return try await client.post(path, body)
        } catch {
            let clientError = error as? ClientError ?? .unreadable
            if clientError == .unreachable { update(\.connection, .down) }
            if !quiet { show(error: clientError.message) }
            return nil
        }
    }

    /// Relit ce qui dépend d'une écriture (sauf en démonstration, où rien ne change côté moteur).
    func reloadAfterWrite(conversation id: String? = nil, mcp reloadMCP: Bool = false, accounts reloadAccounts: Bool = false) async {
        guard !isDemo else { return }
        await refreshOverview()
        if let id { await refreshConversation(id) }
        if reloadMCP { await refreshMCP() }
        if reloadAccounts { await refreshAccounts() }
    }

    // MARK: Messages

    func show(error text: String) {
        toast = Toast(text: text, isError: true)
    }

    func show(info text: String) {
        toast = Toast(text: text, isError: false)
    }

    func dismissToast(_ id: UUID) {
        if toast?.id == id { toast = nil }
    }

    // MARK: Moteur

    func restartEngine() {
        guard !restarting else { return }
        restarting = true
        SystemActions.restartEngine { [weak self] ok in
            guard let self else { return }
            self.restarting = false
            if ok {
                self.show(info: "Moteur relancé")
            } else {
                self.show(error: "Impossible de relancer le moteur")
            }
            Task { await self.refreshOverview() }
        }
    }

    // MARK: Patches locaux (affichage immédiat avant la réponse du moteur)

    func patchSettings(_ change: (inout EngineSettings) -> Void) {
        guard var value = settings else { return }
        change(&value)
        settings = value
    }

    func patchConversation(_ id: String, _ change: (inout ConversationSummary) -> Void) {
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        var value = conversations[index]
        change(&value)
        conversations[index] = value
    }

    func removeReview(_ id: String) {
        toReview.removeAll { $0.id == id }
        settledReview[id] = .now
    }

    /// L'action n'a pas abouti : l'élément revient à sa place.
    func restoreReview(_ item: ReviewItem) {
        settledReview[item.id] = nil
        guard !toReview.contains(where: { $0.id == item.id }) else { return }
        toReview.insert(item, at: 0)
    }

    func patchSince(_ summary: SinceSummary, since date: Date) {
        sinceSummary = summary
        since = date
    }

    func patchAccountsState(_ change: (inout AccountsState) -> Void) {
        guard var value = accountsState else { return }
        change(&value)
        accountsState = value
    }

    func patchAccounts(_ change: (inout [Account]) -> Void) {
        change(&accounts)
    }

    func patchAccount(_ id: String, _ change: (inout Account) -> Void) {
        if let index = accounts.firstIndex(where: { $0.id == id }) { change(&accounts[index]) }
        patchAccountsState { state in
            if let index = state.accounts.firstIndex(where: { $0.id == id }) { change(&state.accounts[index]) }
        }
    }

    func patchMCP(_ change: (inout MCPState) -> Void) {
        guard var value = mcp else { return }
        change(&value)
        mcp = value
    }
}
