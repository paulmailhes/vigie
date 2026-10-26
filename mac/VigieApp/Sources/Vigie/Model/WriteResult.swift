import Foundation

/// Réponse d'une écriture : `{ ok, error? }` plus les champs propres à certaines routes.
struct WriteResult: Decodable, Equatable, Sendable {
    var ok: Bool?
    var error: String?
    /// POST /api/v2/conversation/:id/settings avec accountId.
    @Tolerant var switchInfo: SwitchInfo?
    /// POST /api/v2/questions/:id/review avec action « change ».
    var correction: String?
    var delivered: Bool?
    var openUrl: String?
    /// POST /api/v2/gateway : service sans autorisation (rien à ouvrir dans le navigateur).
    var open: Bool?
    /// Message court facultatif renvoyé par certaines actions.
    var message: String?
    /// POST /api/v2/accounts { action: "create" } : le compte créé.
    @Tolerant var account: CreatedAccount?
    /// POST /api/v2/agents/launch : le dossier du projet (créé ou existant), la consigne remplie qui y est rangée, et
    /// le message à envoyer dans Claude Code (à copier quand il n'a pas pu être prérempli).
    var folder: String?
    var briefFile: String?
    var prompt: String?
    /// Ce que le moteur a ouvert : full, folder, no-prompt, none (AgentOpened). Absent : moteur plus ancien, qui
    /// n'ouvre rien.
    var opened: String?
    /// Où : vscode ou claude-app (AgentSurface).
    var surface: String?
    /// Les fichiers joints, tels que rangés dans le projet (« sources/charte.pdf »).
    @Lossy var copied: [String]

    enum CodingKeys: String, CodingKey {
        case ok, error, correction, delivered, openUrl, message, account, folder, briefFile, prompt, opened, surface, copied
        case switchInfo = "switch"
    }

    init(ok: Bool, error: String? = nil, correction: String? = nil, delivered: Bool? = nil,
         openUrl: String? = nil, message: String? = nil) {
        self.ok = ok
        self.error = error
        self.correction = correction
        self.delivered = delivered
        self.openUrl = openUrl
        self.message = message
        self.switchInfo = nil
        self.account = nil
        self.copied = []
    }
}

struct SwitchInfo: Decodable, Equatable, Sendable {
    var state: String?
    var message: String?
}

struct CreatedAccount: Decodable, Equatable, Sendable {
    var id: String
}
