import Foundation

/// Les gestes de l'utilisateur, traduits en écritures vers le moteur (API v2).
extension VigieStore {
    // MARK: Réglages généraux (liés directement aux contrôles)

    var autoAccept: Bool {
        get { settings?.autoAccept ?? false }
        set {
            patchSettings { $0.autoAccept = newValue }
            Task { await sendSettings(["autoAccept": .bool(newValue)]) }
        }
    }

    var questionsAuto: Bool {
        get { settings?.questionsAuto ?? false }
        set {
            patchSettings { $0.questionsAuto = newValue }
            Task { await sendSettings(["questionsAuto": .bool(newValue)]) }
        }
    }

    var questionWaitMin: Int {
        get { settings?.questionWaitMin ?? 20 }
        set {
            patchSettings { $0.questionWaitMin = newValue }
            Task { await sendSettings(["questionWaitMin": .int(newValue)]) }
        }
    }

    var connectorsDefaultOn: Bool {
        get { (settings?.connectorsDefault ?? mcp?.connectorsDefault) == "on" }
        set {
            let value = newValue ? "on" : "off"
            patchSettings { $0.connectorsDefault = value }
            patchMCP { $0.connectorsDefault = value }
            Task {
                await sendSettings(["connectorsDefault": .string(value)])
                await reloadAfterWrite(mcp: true)
            }
        }
    }

    // MARK: Garde-fous

    var guardEnabled: Bool {
        get { settings?.guardRules?.enabled ?? true }
        set {
            patchGuard { $0.enabled = newValue }
            Task { await sendSettings(["guard": ["enabled": .bool(newValue)]]) }
        }
    }

    var guardWaitMin: Int {
        get { settings?.guardRules?.waitMin ?? 10 }
        set {
            patchGuard { $0.waitMin = newValue }
            Task { await sendSettings(["guard": ["waitMin": .int(newValue)]]) }
        }
    }

    func setGuardRule(_ id: String, active: Bool) {
        patchGuard { value in
            if let index = value.rules.firstIndex(where: { $0.id == id }) { value.rules[index].disabled = !active }
        }
        Task {
            await sendSettings(["guard": ["rules": [["id": .string(id), "disabled": .bool(!active)]]]])
        }
    }

    private func patchGuard(_ change: (inout GuardSettings) -> Void) {
        patchSettings { settings in
            var value = settings.guardRules ?? GuardSettings()
            change(&value)
            settings.guardRules = value
        }
    }

    private func sendSettings(_ body: JSONValue) async {
        await write("/api/v2/settings", body)
        await reloadAfterWrite()
    }

    // MARK: Vue d'ensemble

    func markSeen() async {
        let previous = sinceSummary
        patchSince(SinceSummary(accepted: 0, questionsAuto: 0, blocked: 0, reports: 0, testsFailed: 0, limits: 0), since: .now)
        if await write("/api/v2/seen", [:]) == nil, let previous {
            patchSince(previous, since: since ?? .now)
        }
        await reloadAfterWrite()
    }

    func acceptReview(_ item: ReviewItem) async {
        removeReview(item.id)
        await write("/api/v2/questions/\(encode(item.questionID))/review", ["action": "ok"])
        await reloadAfterWrite()
    }

    /// L'utilisateur choisit une autre option : renvoie le texte de correction à donner à la conversation.
    func changeReview(_ item: ReviewItem, answers: [String: String]) async -> WriteResult? {
        let payload = JSONValue.object(answers.mapValues { JSONValue.string($0) })
        let result = await write("/api/v2/questions/\(encode(item.questionID))/review",
                                 ["action": "change", "answers": payload])
        if result != nil {
            removeReview(item.id)
            await reloadAfterWrite()
        }
        return result
    }

    // MARK: Actions sensibles

    /// Autorise ou refuse une action sensible en attente (comme un clic dans VS Code).
    func decidePending(_ item: ReviewItem, allow: Bool) async -> Bool {
        guard let pending = item.pendingId else { return false }
        let result = await write("/api/v2/pending/\(encode(pending))", ["decision": .string(allow ? "allow" : "deny")])
        if let result {
            removeReview(item.id)
            show(info: result.message ?? (allow ? "Autorisée" : "Refusée"))
        }
        await reloadAfterWrite(conversation: item.conversationId)
        return result != nil
    }

    /// Mode « seulement par Vigie » : autorise une fois, pour la commande exacte, ou refuse.
    /// Autorisée sans livraison directe : le message est copié et la conversation ouverte.
    func decideApproval(_ item: ReviewItem, allow: Bool) async -> Bool {
        guard let approval = item.approvalId else { return false }
        var body: [String: JSONValue] = ["approvalId": .string(approval)]
        if !allow { body["decision"] = "deny" }
        guard let result = await write("/api/v2/approvals", .object(body)) else {
            await reloadAfterWrite(conversation: item.conversationId)
            return false
        }
        removeReview(item.id)
        if !allow {
            show(info: "Refusée : rien n'est envoyé")
        } else if result.delivered == true {
            show(info: result.message ?? "Autorisée : elle se lance dans sa conversation")
        } else {
            // Elle avait continué sans : rien ne s'ouvre (VS Code choisissait souvent la mauvaise fenêtre) ;
            // le message est copié, à coller dans sa conversation si elle ne relance pas l'action d'elle-même.
            if let message = result.message, !message.isEmpty { SystemActions.copy(message) }
            show(info: "Autorisée. Elle avait continué sans : message copié, colle-le dans sa conversation pour qu'elle relance l'action")
        }
        await reloadAfterWrite(conversation: item.conversationId)
        return true
    }

    /// Répond à une question en attente : la réponse part à Claude comme si tu avais cliqué dans VS Code.
    func answerPending(_ item: ReviewItem, answers: [String: String]) async -> Bool {
        guard let pending = item.pendingId else { return false }
        let body: [String: JSONValue] = ["answers": .object(answers.mapValues { .string($0) })]
        guard let result = await write("/api/v2/pending/\(encode(pending))", .object(body)) else { return false }
        removeReview(item.id)
        show(info: result.message ?? "Réponse envoyée à Claude")
        await reloadAfterWrite(conversation: item.conversationId)
        return true
    }

    /// Retire un élément de « À regarder ».
    func dismissReview(_ item: ReviewItem) async {
        removeReview(item.id)
        await write("/api/v2/review/\(encode(item.id))/dismiss", [:])
        await reloadAfterWrite()
    }

    /// Ouvre la conversation dans VS Code (par le moteur ; sinon le dossier du projet).
    func openConversationInVSCode(_ id: String?, cwd: String?) async {
        if let id, await write("/api/v2/open", ["kind": "conversation", "id": .string(id)], quiet: true) != nil {
            show(info: "Conversation ouverte dans VS Code")
            return
        }
        if let cwd = cwd ?? id.flatMap({ conversation($0)?.cwd }) {
            SystemActions.openInVSCode(path: cwd)
        } else {
            SystemActions.activateVSCode()
        }
    }

    /// Prépare la commande dans Terminal (non exécutée : tu appuies sur Entrée et tapes ton mot de passe).
    func runInTerminal(_ command: String, cwd: String?) async {
        var body: [String: JSONValue] = ["kind": "terminal", "command": .string(command)]
        if let cwd { body["cwd"] = .string(cwd) }
        if await write("/api/v2/open", .object(body), quiet: true) != nil {
            show(info: "Terminal ouvert : appuie sur Entrée, puis tape ton mot de passe")
            return
        }
        SystemActions.copy(command)
        SystemActions.openTerminal()
        show(info: "Commande copiée : colle-la dans Terminal")
    }

    // MARK: Conversation

    /// nil = comme le réglage général.
    func setAutoAccept(_ value: Bool?, for id: String) async {
        let general = autoAccept
        patchConversation(id) {
            $0.autoAcceptOverride = value
            $0.autoAccept = value ?? general
        }
        await write("/api/v2/conversation/\(encode(id))/settings", ["autoAccept": .optional(value)])
        await reloadAfterWrite(conversation: id)
    }

    func setConnectors(_ on: Bool, for id: String) async {
        patchConversation(id) { $0.connectors = on ? "on" : "off" }
        await write("/api/v2/conversation/\(encode(id))/settings", ["connectors": .string(on ? "on" : "off")])
        await reloadAfterWrite(conversation: id)
    }

    func switchAccount(of id: String, to accountID: String, now: Bool = false) async {
        var body: [String: JSONValue] = ["accountId": .string(accountID)]
        if now { body["now"] = .bool(true) }
        let result = await write("/api/v2/conversation/\(encode(id))/settings", .object(body))
        guard let result else { return }
        patchConversation(id) { $0.accountId = accountID }
        let label = accounts.first(where: { $0.id == accountID })?.displayName ?? accountID
        show(info: result.switchInfo?.message ?? result.message ?? "Passera sur \(label) à ton prochain message")
        await reloadAfterWrite(conversation: id)
    }

    // MARK: Comptes

    func createAccount(label: String) async {
        let result = await write("/api/v2/accounts", ["action": "create", "label": .string(label)])
        if result != nil { show(info: result?.message ?? "Compte « \(label) » ajouté") }
        await reloadAfterWrite(accounts: true)
    }

    /// Accueil : crée le compte puis ouvre aussitôt sa connexion dans le navigateur.
    func createAndConnectAccount(label: String, email: String?) async {
        var body: [String: JSONValue] = ["action": "create", "label": .string(label)]
        if let email { body["email"] = .string(email) }
        guard let result = await write("/api/v2/accounts", .object(body)), let id = result.account?.id else {
            await reloadAfterWrite(accounts: true)
            return
        }
        await connectAccount(id)
    }

    /// Codex : connexion par le navigateur (codex login).
    func codexLogin() async {
        let result = await write("/api/v2/accounts", ["action": "codexLogin"])
        if result != nil { show(info: result?.message ?? "Le navigateur s'ouvre : connecte-toi avec ton compte ChatGPT") }
        await reloadAfterWrite(accounts: true)
    }

    func setDefaultAccount(_ id: String) async {
        patchAccountsState { $0.defaultForNew = id }
        patchAccounts { list in
            for index in list.indices { list[index].isDefault = list[index].id == id }
        }
        await write("/api/v2/accounts", ["action": "setDefault", "id": .string(id)])
        await reloadAfterWrite(accounts: true)
    }

    func connectAccount(_ id: String) async {
        let result = await write("/api/v2/accounts", ["action": "connect", "id": .string(id)])
        if result != nil { show(info: result?.message ?? "Terminal ouvert : tape /login") }
        await reloadAfterWrite(accounts: true)
    }

    /// Relève à nouveau les crédits d'un compte (ou de tous) : POST {action: "refresh", id}.
    func refreshUsage(_ id: String?) async {
        var body: [String: JSONValue] = ["action": "refresh"]
        if let id { body["id"] = .string(id) }
        let result = await write("/api/v2/accounts", .object(body))
        if result != nil {
            let name = id.flatMap { account($0)?.displayName }
            show(info: result?.message ?? (name.map { "Relevé de \($0) demandé" } ?? "Relevé des comptes demandé"))
        }
        await reloadAfterWrite(accounts: true)
    }

    func setWrapper(_ enable: Bool) async {
        patchAccountsState { state in
            var wrapper = state.wrapper ?? WrapperState()
            wrapper.active = enable
            state.wrapper = wrapper
        }
        let result = await write("/api/v2/accounts", ["action": "wrapper", "enable": .bool(enable)])
        if result != nil {
            show(info: result?.message ?? (enable ? "Choix du compte activé dans VS Code" : "Choix du compte désactivé"))
        }
        await reloadAfterWrite(accounts: true)
    }

    // MARK: MCP

    func mcpUser(_ action: String, name: String, config: JSONValue? = nil, accounts ids: [String]? = nil) async -> Bool {
        var body: [String: JSONValue] = ["action": .string(action), "name": .string(name)]
        if let config { body["config"] = config }
        if let ids { body["accounts"] = .array(ids.map(JSONValue.string)) }
        let ok = await write("/api/v2/mcp/user", .object(body)) != nil
        await reloadAfterWrite(mcp: true)
        return ok
    }

    func mcpProject(_ action: String, path: String, name: String, config: JSONValue? = nil) async -> Bool {
        var body: [String: JSONValue] = ["action": .string(action), "path": .string(path), "name": .string(name)]
        if let config { body["config"] = config }
        let ok = await write("/api/v2/mcp/project", .object(body)) != nil
        await reloadAfterWrite(mcp: true)
        return ok
    }

    func mcpDisable(path: String, name: String, disabled: Bool) async {
        patchMCP { state in
            for index in state.projects.indices where state.projects[index].path == path {
                for server in state.projects[index].servers.indices where state.projects[index].servers[server].name == name {
                    state.projects[index].servers[server].disabled = disabled
                }
            }
        }
        if await write("/api/v2/mcp/disable", ["path": .string(path), "name": .string(name), "disabled": .bool(disabled)]) != nil {
            show(info: disabled ? "« \(name) » coupé ici" : "« \(name) » rallumé")
        }
        await reloadAfterWrite(mcp: true)
    }

    /// Coupe ou rallume un MCP de ton Mac dans plusieurs projets d'un coup (un appel par projet).
    func mcpSetEverywhere(name: String, disabled: Bool, paths: [String]) async {
        guard !paths.isEmpty else { return }
        patchMCP { state in
            for index in state.user.indices where state.user[index].name == name {
                var list = state.user[index].disabledIn
                if disabled {
                    for path in paths where !list.contains(path) { list.append(path) }
                } else {
                    list.removeAll { paths.contains($0) }
                }
                state.user[index].disabledIn = list
            }
        }
        var failed = 0
        for path in paths {
            let result = await write("/api/v2/mcp/disable", ["path": .string(path), "name": .string(name), "disabled": .bool(disabled)])
            if result == nil { failed += 1 }
        }
        if failed == 0 {
            let count = Fmt.count(paths.count, "projet")
            show(info: disabled ? "« \(name) » coupé dans \(count)" : "« \(name) » rallumé dans \(count)")
        }
        await reloadAfterWrite(mcp: true)
    }

    /// Coupe ou rallume un MCP de ton Mac pour un seul projet.
    func mcpUserDisable(path: String, name: String, disabled: Bool) async {
        await mcpSetEverywhere(name: name, disabled: disabled, paths: [path])
    }

    /// Relance tout de suite la vérification des MCP (sinon toutes les 10 min).
    func mcpCheck(accountId: String? = nil, path: String? = nil) async {
        var body: [String: JSONValue] = [:]
        if let accountId { body["accountId"] = .string(accountId) }
        if let path { body["path"] = .string(path) }
        mcpChecking = true
        defer { mcpChecking = false }
        guard await write("/api/v2/mcp/check", .object(body)) != nil else { return }
        show(info: "Vérification lancée")
        guard !isDemo else { return }
        try? await Task.sleep(for: .seconds(8))
        await refreshMCP()
    }

    /// Lance la connexion d'un MCP dans le bon compte et le bon dossier (le navigateur s'ouvre).
    /// Moteur plus ancien : repli sur « /mcp » dans VS Code.
    func mcpConnect(name: String, accountId: String?, path: String?, force: Bool = false) async {
        var body: [String: JSONValue] = ["name": .string(name)]
        if let accountId { body["accountId"] = .string(accountId) }
        if let path { body["path"] = .string(path) }
        if force { body["force"] = .bool(true) }
        if let result = await write("/api/v2/mcp/connect", .object(body), quiet: true) {
            let suffix = accountId.flatMap { account($0)?.displayName }.map { " (\($0))" } ?? ""
            show(info: result.message ?? "Autorise « \(name) »\(suffix) dans ton navigateur")
            await reloadAfterWrite(mcp: true)
        } else {
            MCPHelp.reconnect(name, path: path, store: self)
        }
    }

    /// « Partout » : chaque compte qui demande ce MCP, l'un après l'autre (une page d'autorisation à la fois).
    func mcpConnectEverywhere(name: String) async {
        guard let result = await write("/api/v2/mcp/connect", ["name": .string(name), "everywhere": .bool(true)]) else { return }
        show(info: result.message ?? "Autorise « \(name) » dans ton navigateur, pour chaque compte")
        await reloadAfterWrite(mcp: true)
    }

    // MARK: Outils

    /// Le résumé vivant (vue d'ensemble, toutes les 3 s), complété par le détail (branche, début…).
    func conversation(_ id: String) -> ConversationSummary? {
        let live = conversations.first { $0.id == id }
        guard let detail = details[id]?.raw.summary else { return live }
        guard var merged = live else { return detail }
        merged.branch = merged.branch ?? detail.branch
        merged.startedAt = merged.startedAt ?? detail.startedAt
        merged.cwd = merged.cwd ?? detail.cwd
        merged.contextTokens = merged.contextTokens ?? detail.contextTokens
        return merged
    }

    func account(_ id: String?) -> Account? {
        guard let id else { return accounts.first { $0.isDefault == true } }
        return accounts.first { $0.id == id } ?? accountsState?.accounts.first { $0.id == id }
    }

    var toReviewCount: Int { toReview.count }

    /// Ouvre la page Comptes sur un compte (chaque compte est une ligne de la barre latérale).
    func showAccounts(_ id: String?) {
        let list = accounts.isEmpty ? (accountsState?.accounts ?? []) : accounts
        guard let target = id ?? list.first(where: { $0.isDefault == true })?.id ?? list.first?.id else { return }
        route = .account(target)
    }

    private func encode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }
}
