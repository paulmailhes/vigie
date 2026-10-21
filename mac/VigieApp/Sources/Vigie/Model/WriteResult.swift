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

    enum CodingKeys: String, CodingKey {
        case ok, error, correction, delivered, openUrl, message, account
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
    }
}

struct SwitchInfo: Decodable, Equatable, Sendable {
    var state: String?
    var message: String?
}

struct CreatedAccount: Decodable, Equatable, Sendable {
    var id: String
}
