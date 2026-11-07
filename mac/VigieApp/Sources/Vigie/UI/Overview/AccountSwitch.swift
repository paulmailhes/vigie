import Foundation

/// Changer le compte d'une conversation arrêtée par une limite : le compte à proposer et le texte de la confirmation,
/// le même que celui du menu Compte de la barre de la conversation (ConversationBar). Jamais automatique : une
/// conversation commencée garde son compte tant que tu n'en choisis pas un autre.
enum AccountSwitch {
    /// À partir de là, un compte n'a plus de marge (session ou semaine).
    static let fullPct: Double = 90

    /// Le compte connecté qui a le plus de marge pour reprendre une conversation arrêtée sur `limited` : session et
    /// semaine sous 90 %, la plus petite session d'abord, puis la plus petite semaine. nil : aucun ne convient.
    /// Jamais un compte Codex, ni un compte branché sur le même compte claude.ai que `limited` (même limite).
    static func freeAccount(in accounts: [Account], limited: String?, excluding: Set<String> = [], now: Date) -> Account? {
        let sameAsLimited = Set(accounts.first { $0.id == limited }?.sameAs ?? [])
        return accounts
            .filter { account in
                account.isConnected && !account.isCodex && account.id != limited && !excluding.contains(account.id)
                    && !sameAsLimited.contains(account.id) && !(account.sameAs ?? []).contains { $0 == limited }
            }
            .map { (account: $0, session: pct($0.usage?.session, now: now), week: pct($0.usage?.week, now: now)) }
            .filter { $0.session < fullPct && $0.week < fullPct }
            .min { ($0.session, $0.week) < ($1.session, $1.week) }?
            .account
    }

    /// La part utilisée d'une fenêtre : 0 une fois sa remise à zéro passée, ou sans relevé (compte pas encore servi).
    static func pct(_ window: UsageWindow?, now: Date) -> Double {
        guard let pct = window?.pct else { return 0 }
        if let reset = window?.resetsAt, reset <= now { return 0 }
        return pct
    }

    /// Le texte de la confirmation : ce que devient la conversation, et ce que coûte la relecture sur le nouveau compte.
    static func message(working: Bool, to account: Account, contextTokens: Int?) -> String {
        var text = working
            ? "Elle travaille : elle change de compte à la fin de son tour, ou tout de suite en l'interrompant (tu écris « continue » pour la reprendre)."
            : "Elle reprend sur \(account.displayName) avec tout son historique."
        if let contextTokens, contextTokens > 0 {
            text += " ≈ \(Fmt.tokens(contextTokens)) tokens relus sur le nouveau compte."
        }
        return text
    }
}
