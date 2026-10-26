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
    /// Conversations telles qu'affichées : remplacées seulement quand ce qui se voit change (voir `screenKey`).
    private(set) var conversations: [ConversationSummary] = []
    /// Les mêmes, à jour à chaque relevé (dernière activité exacte…), sans redessiner l'interface.
    @ObservationIgnored private(set) var latestConversations: [ConversationSummary] = []
    /// Ce que montre l'icône de la barre des menus. AppKit la redessine pour chaque écran à chaque changement :
    /// elle ne lit que ces deux valeurs, pas toute la liste « À regarder » ni tous les réglages.
    private(set) var reviewBadge = 0
    private(set) var autoAcceptBadge = false
    /// Fenêtre principale à l'écran (ni réduite, ni cachée, ni recouverte, écran allumé) : les pages ne sont relues
    /// que là ; sinon la vue d'ensemble l'est toutes les 15 s (60 s écran en veille), pour la barre des menus et les
    /// notifications.
    private(set) var windowVisible = true
    @ObservationIgnored var menuPanelOpen = false { didSet { pollingChanged() } }
    @ObservationIgnored private var windowShown = true
    @ObservationIgnored private var screensAsleep = false

    /// Ce qui se voit d'une liste de conversations. Pendant le travail, la dernière activité, la part de la semaine,
    /// les tokens relus et les compteurs d'acceptations changent à chaque relevé sans s'afficher tels quels, et le débit
    /// change au-delà de ce qui s'affiche : comparés sans eux (débit pris tel qu'il s'écrit à l'écran), ils ne
    /// redessinent plus toute la fenêtre toutes les 3 s.
    struct ScreenRow: Equatable {
        var conversation: ConversationSummary
        var rate: String
        var tokens: String
        var spark: [Double]
        var trend: String?
    }

    static func screenKey(_ list: [ConversationSummary]) -> [ScreenRow] {
        list.map { conversation in
            var c = conversation
            c.lastActivity = nil
            c.weekPct = nil
            c.contextTokens = nil
            c.accepted = nil
            let rate = c.rate
            c.rate = nil
            return ScreenRow(conversation: c, rate: rate?.weekPctPerHour.map(Fmt.rate) ?? "",
                             tokens: rate?.tokensPerMin.map(Fmt.tokensPerMin) ?? "",
                             spark: shape(rate?.spark ?? []), trend: rate?.trend)
        }
    }

    /// Forme de la mini-courbe, à 1/20 de sa hauteur : elle est dessinée par rapport à son maximum.
    private static func shape(_ values: [Double]) -> [Double] {
        guard let top = values.max(), top > 0 else { return values }
        return values.map { ($0 / top * 20).rounded() }
    }

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
    /// Les agents (recettes à lancer) et le compte sur lequel ils partiraient.
    private(set) var agentsState: AgentLibrary?
    /// Le moteur refuse la liste des agents (trop ancien…) : dit dans la page, sans bandeau.
    private(set) var agentsProblem: String?
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
    /// Installation du moteur par l'app elle-même (app glissée dans Applications) : en cours, ou échouée.
    enum Setup: Equatable { case idle, installing, failed(String) }
    var setup: Setup = .idle

    /// Attend que le moteur réponde (première installation en cours), au plus `seconds`.
    func waitForEngine(seconds: Int = 120) async {
        guard !isDemo else { return }
        for _ in 0..<(seconds * 2) {
            if setup == .idle && connection == .ok { return }
            try? await Task.sleep(for: .milliseconds(500))
        }
    }

    func runSetup() async {
        setup = .installing
        if let error = await EngineBootstrap.install() {
            setup = .failed(error)
        } else {
            setup = .idle
            await refreshOverview()
        }
    }

    /// Outils choisis dans l'accueil (VS Code, app Claude, app ChatGPT…), sinon ceux trouvés sur le Mac.
    private(set) var tools: ToolsState?
    /// Historique : filtres de la page et dernière page lue.
    var historyStatus: String?
    var historyWindow = 1440
    var historyQuery = ""
    var historyConversation: String?
    private(set) var historyPage: HistoryPage?
    /// Mise à jour de Vigie (bandeau, Réglages) ; « Quoi de neuf » après une mise à jour.
    private(set) var updateStatus: UpdateStatus?
    var whatsNew: [ReleaseNote]?
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

    /// Démarre le sondage de la vue d'ensemble : toutes les 3 s à l'écran, 15 s fenêtre cachée, 60 s écran en veille
    /// (une seule lecture en démonstration).
    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refreshOverview()
                if self.isDemo && self.loadedOnce { return }
                let seconds = self.pollSeconds
                try? await Task.sleep(for: .seconds(seconds), tolerance: .seconds(seconds / 3 + 1))
            }
        }
    }

    private var pollSeconds: Int { windowVisible || menuPanelOpen ? 3 : screensAsleep ? 60 : 15 }

    /// Fenêtre principale à l'écran ou non (WindowVisibility) ; écran en veille : comme cachée.
    func setWindowVisible(_ shown: Bool) {
        windowShown = shown
        pollingChanged()
    }

    func setScreensAsleep(_ asleep: Bool) {
        screensAsleep = asleep
        pollingChanged()
    }

    /// Le rythme change : la boucle repart tout de suite (relecture immédiate), au lieu de finir une attente de 15 ou
    /// 60 s ; les pages repartent d'elles-mêmes avec `windowVisible` (`.task(id:)`).
    @ObservationIgnored private var lastPollSeconds = 3
    private func pollingChanged() {
        let visible = windowShown && !screensAsleep
        if visible != windowVisible { windowVisible = visible }
        let seconds = pollSeconds
        guard seconds != lastPollSeconds else { return }
        let faster = seconds < lastPollSeconds
        lastPollSeconds = seconds
        guard faster, pollTask != nil else { return }
        pollTask?.cancel()
        pollTask = nil
        start()
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

    /// Suit une conversation affichée, jusqu'à ce que la vue disparaisse ou que la fenêtre se cache : son détail
    /// (des centaines de Ko) n'est relu que quand elle a avancé (dernière activité, vue d'ensemble), au plus toutes
    /// les 4 s, et toutes les 30 s sinon.
    func follow(conversation id: String) async {
        var seen: Date?
        var readAt = ContinuousClock.now - .seconds(60)
        while !Task.isCancelled {
            guard windowVisible || isDemo else { return }
            let activity = latestConversations.first { $0.id == id }?.lastActivity
            let missing = details[id] == nil && !gone.contains(id)
            if missing || activity != seen || ContinuousClock.now - readAt >= .seconds(30) {
                seen = activity
                readAt = .now
                await refreshConversation(id)
            }
            if isDemo { return }
            try? await Task.sleep(for: .seconds(4), tolerance: .seconds(1))
        }
    }

    func refreshConversation(_ id: String) async {
        if isDemo, details[id] != nil { return }
        let started = ContinuousClock.now
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        do {
            let detail = try await client.get("/api/v2/conversation/\(encoded)", as: ConversationDetail.self)
            guard isFresh(started) else { return }
            gone.remove(id)
            if details[id]?.raw != detail {
                details[id] = await Task.detached(priority: .userInitiated) { ConversationDetailModel(detail) }.value
                keepDetails(around: id)
            }
            readSucceeded()
        } catch ClientError.notFound {
            gone.insert(id)
        } catch {
            readFailed(error)
        }
    }

    /// Conversations que le moteur ne connaît plus (404) : relues toutes les 30 s seulement.
    @ObservationIgnored private var gone: Set<String> = []

    /// Détails gardés en mémoire : la conversation lue à l'instant et les 3 précédentes.
    @ObservationIgnored private var detailOrder: [String] = []
    private func keepDetails(around id: String) {
        detailOrder.removeAll { $0 == id }
        detailOrder.append(id)
        while detailOrder.count > 4 { details[detailOrder.removeFirst()] = nil }
    }

    /// Suit le graphique de consommation affiché (toutes les 30 s).
    func followUsage(_ span: UsageSpan) async {
        while !Task.isCancelled {
            guard windowVisible || isDemo else { return }
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
            guard windowVisible || isDemo else { return }
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
            guard windowVisible || isDemo else { return }
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

    /// Suit la page Agents (toutes les 30 s : un AGENT.md ajouté, un MCP connecté entre-temps).
    func followAgents() async {
        while !Task.isCancelled {
            guard windowVisible || isDemo else { return }
            await refreshAgents()
            if isDemo { return }
            try? await Task.sleep(for: .seconds(30), tolerance: .seconds(5))
        }
    }

    func refreshAgents() async {
        if isDemo, agentsState != nil { return }
        let started = ContinuousClock.now
        do {
            let state = try await client.get("/api/v2/agents", as: AgentLibrary.self)
            guard isFresh(started) else { return }
            update(\.agentsState, state)
            update(\.agentsProblem, nil)
            readSucceeded()
        } catch ClientError.refused(let text) {
            // moteur sans la page Agents (trop ancien) : la page le dit ; un bandeau reviendrait toutes les 30 s
            if !Task.isCancelled { update(\.agentsProblem, text) }
        } catch {
            readFailed(error)
        }
    }

    // MARK: Application des données

    private func apply(_ overview: Overview) {
        if isDemo { update(\.engineNow, overview.now) }
        update(\.settings, overview.settings)
        update(\.autoAcceptBadge, overview.settings?.autoAccept ?? false)
        update(\.since, overview.since)
        update(\.sinceSummary, overview.sinceSummary)
        settledReview = settledReview.filter { Date.now.timeIntervalSince($0.value) < 15 }
        update(\.toReview, overview.toReview.filter { settledReview[$0.id] == nil })
        update(\.reviewBadge, toReview.count)
        update(\.reports, RowIDs.make(overview.reports) { $0.stableKey })
        update(\.accounts, overview.accounts)
        // Ordre STABLE (L'utilisateur : « les conversations passent les unes devant les autres ») : ouvertes d'abord,
        // puis par nom de projet ; les fermées de la plus récente à la plus ancienne. L'activité ne déplace plus rien.
        let ordered = Self.stableOrder(overview.conversations)
        latestConversations = ordered
        if Self.screenKey(ordered) != Self.screenKey(conversations) { conversations = ordered }
        update(\.recentAccepted, overview.recentAccepted)
        update(\.engineInfo, overview.engine)
        if let status = overview.update { setUpdateStatus(status) }
        update(\.loadedOnce, true)
    }

    func refreshTools() async {
        guard !isDemo, let state = try? await client.get("/api/v2/tools", as: ToolsState.self) else { return }
        update(\.tools, state)
    }

    func saveTools(_ choice: ToolsChoice) async {
        update(\.tools, ToolsState(detected: tools?.detected, chosen: choice))
        let body: JSONValue = ["tools": ["claudeVSCode": .bool(choice.claudeVSCode), "claudeApp": .bool(choice.claudeApp),
                                         "codexVSCode": .bool(choice.codexVSCode), "codexApp": .bool(choice.codexApp)]]
        _ = await write("/api/v2/settings", body)
    }

    func refreshHistory() async {
        guard !isDemo else { return }
        var query = "window=\(historyWindow)"
        if let historyStatus { query += "&status=\(historyStatus)" }
        if let historyConversation { query += "&conversation=\(encode(historyConversation))" }
        let q = historyQuery.trimmingCharacters(in: .whitespaces)
        if !q.isEmpty { query += "&q=\(encode(q))" }
        guard let page = try? await client.get("/api/v2/history?\(query)", as: HistoryPage.self) else { return }
        update(\.historyPage, page)
    }

    func openHistory(status: String?, window: Int) {
        historyStatus = status
        historyWindow = window
        historyConversation = nil
        historyQuery = ""
        route = .history
    }

    func refreshUpdate() async {
        guard !isDemo, let status = try? await client.get("/api/v2/update", as: UpdateStatus.self) else { return }
        setUpdateStatus(status)
    }

    private func setUpdateStatus(_ status: UpdateStatus) {
        update(\.updateStatus, status)
        noteWhatsNew()
    }

    /// Premier lancement après une mise à jour : les notes des versions arrivées, une seule fois.
    /// Première installation : rien (l'accueil s'en charge), la version est seulement notée.
    private func noteWhatsNew() {
        guard !isDemo, !LaunchOptions.current.isViewer, let current = updateStatus?.current else { return }
        let key = "whatsNew.shownVersion"
        let defaults = UserDefaults.standard
        guard let shown = defaults.string(forKey: key) else { defaults.set(current, forKey: key); return }
        guard Self.isNewer(current, than: shown) else { return }
        defaults.set(current, forKey: key)
        let notes = (updateStatus?.releases ?? []).filter { Self.isNewer($0.version, than: shown) && !Self.isNewer($0.version, than: current) }
        if !notes.isEmpty { whatsNew = notes }
    }

    static func isNewer(_ a: String, than b: String) -> Bool {
        let x = a.split(separator: ".").map { Int($0) ?? 0 }, y = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(x.count, y.count) {
            let l = i < x.count ? x[i] : 0, r = i < y.count ? y[i] : 0
            if l != r { return l > r }
        }
        return false
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
        // relevé interrompu exprès (fenêtre cachée, rythme changé, page quittée) : ce n'est pas une panne du moteur
        if Task.isCancelled { return }
        let clientError = error as? ClientError ?? .unreadable
        switch clientError {
        case .unreachable:
            update(\.connection, .down)
        case .refused(let text):
            update(\.connection, .failing(text))
        case .notFound:
            break // l'élément n'existe plus : la page le dit, le moteur va bien
        case .unreadable, .missingFixture:
            if lastReadError != clientError.message {
                lastReadError = clientError.message
                show(error: clientError.message)
            }
        }
    }

    // MARK: Écritures

    /// POST vers le moteur. Les erreurs s'affichent (sauf `quiet`) ; renvoie nil en cas d'échec.
    @discardableResult
    func write(_ path: String, _ body: JSONValue, quiet: Bool = false) async -> WriteResult? {
        switch await send(path, body) {
        case .success(let result): return result
        case .failure(let error):
            if !quiet { show(error: error.message) }
            return nil
        }
    }

    /// POST vers le moteur, avec son erreur : pour choisir quoi faire selon la raison d'un refus.
    func send(_ path: String, _ body: JSONValue) async -> Result<WriteResult, ClientError> {
        writesInFlight += 1
        defer {
            writesInFlight -= 1
            lastWriteEnd = .now
        }
        do {
            return .success(try await client.post(path, body))
        } catch {
            let clientError = error as? ClientError ?? .unreadable
            if clientError == .unreachable { update(\.connection, .down) }
            return .failure(clientError)
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
                self.show(info: "Moteur de Vigie relancé")
            } else {
                self.show(error: "Impossible de relancer le moteur de Vigie : quitte Vigie et rouvre-le")
            }
            Task { await self.refreshOverview() }
        }
    }

    // MARK: Patches locaux (affichage immédiat avant la réponse du moteur)

    func patchSettings(_ change: (inout EngineSettings) -> Void) {
        guard var value = settings else { return }
        change(&value)
        settings = value
        update(\.autoAcceptBadge, value.autoAccept ?? false)
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
        update(\.reviewBadge, toReview.count)
    }

    /// L'action n'a pas abouti : l'élément revient à sa place.
    func restoreReview(_ item: ReviewItem) {
        settledReview[item.id] = nil
        guard !toReview.contains(where: { $0.id == item.id }) else { return }
        toReview.insert(item, at: 0)
        update(\.reviewBadge, toReview.count)
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
