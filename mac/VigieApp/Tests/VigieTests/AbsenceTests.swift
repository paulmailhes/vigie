import Foundation
import Testing
@testable import Vigie

/// « Pendant ton absence » : plus de 2 h d'absence, résumée pendant 30 min après le retour, 24 h au plus.
@MainActor
struct AbsenceTests {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func shortAbsencesAreForgotten() {
        var absence = Absence()
        absence.leave(at: start)
        absence.back(at: start.addingTimeInterval(2 * 3600))
        #expect(absence.leftAt == nil)
        #expect(absence.from == nil)
        #expect(absence.since(now: start.addingTimeInterval(2 * 3600 + 60)) == nil)
    }

    @Test func aLongAbsenceIsSummedUpForThirtyMinutes() {
        var absence = Absence()
        absence.leave(at: start)
        // un second départ (écrans en veille après la fenêtre cachée) ne déplace pas le début
        absence.leave(at: start.addingTimeInterval(600))
        let back = start.addingTimeInterval(8 * 3600)
        absence.back(at: back)
        #expect(absence.from == start)
        #expect(absence.returnedAt == back)
        #expect(absence.since(now: back) == start)
        #expect(absence.since(now: back.addingTimeInterval(29 * 60)) == start)
        // 30 min après le retour : « Depuis une heure » revient d'elle-même
        #expect(absence.since(now: back.addingTimeInterval(30 * 60)) == nil)
        // une horloge qui recule ne remet rien
        #expect(absence.since(now: back.addingTimeInterval(-60)) == nil)
    }

    @Test func aShortBreakKeepsTheSummaryOfTheLongAbsence() {
        var absence = Absence()
        absence.leave(at: start)
        let back = start.addingTimeInterval(3 * 3600)
        absence.back(at: back)
        // tu passes dans VS Code 5 min, puis reviens : la bande dit encore l'absence, jusqu'à 30 min après le retour
        absence.leave(at: back.addingTimeInterval(5 * 60))
        #expect(absence.since(now: back.addingTimeInterval(6 * 60)) == start)
        absence.back(at: back.addingTimeInterval(10 * 60))
        #expect(absence.from == start)
        #expect(absence.since(now: back.addingTimeInterval(15 * 60)) == start)
        #expect(absence.since(now: back.addingTimeInterval(31 * 60)) == nil)
    }

    @Test func theSummaryNeverGoesBackMoreThanADay() {
        var absence = Absence()
        absence.leave(at: start)
        let back = start.addingTimeInterval(30 * 3600)
        absence.back(at: back)
        #expect(absence.since(now: back) == back.addingTimeInterval(-24 * 3600))
    }

    @Test func comingBackWithoutLeavingDoesNothing() {
        var absence = Absence()
        absence.back(at: start)
        #expect(absence == Absence())
    }

    @Test func absenceIsKeptAcrossLaunches() throws {
        let suite = "vigie.essais.absence.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var absence = Absence()
        absence.leave(at: start)
        absence.save(to: defaults)
        #expect(Absence.load(from: defaults) == absence)
        absence.back(at: start.addingTimeInterval(3 * 3600))
        absence.save(to: defaults)
        let loaded = Absence.load(from: defaults)
        #expect(loaded.leftAt == nil)
        #expect(loaded.from == start)
    }

    /// Les données d'exemple : la bande prend la période que le moteur a résumée, puis redevient « Depuis une heure ».
    @Test func theOverviewSaysTheWindowTheEngineUsed() async throws {
        let store = VigieStore(client: VigieClient(source: .fixtures(Self.previewFolder)))
        await store.refreshOverview()
        #expect(store.absenceFrom == nil)
        let from = try #require(store.since)
        await store.previewAbsence(from: from)
        #expect(store.absenceFrom == from)
        #expect(!store.absenceCapped)
        await store.previewAbsence(from: nil)
        #expect(store.absenceFrom == nil)
    }

    static var previewFolder: URL {
        URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Preview", directoryHint: .isDirectory)
    }
}

/// La vue d'ensemble : le compte libre proposé après une limite, le verdict d'une demande finie, ce qui redessine.
@MainActor
struct OverviewFactsTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func accounts(_ json: String) throws -> [Account] {
        try JSONDecoder().decode([Account].self, from: Data(json.utf8))
    }

    @Test func aLimitProposesTheAccountWithTheMostRoom() throws {
        let later = now.addingTimeInterval(3600).formatted(.iso8601)
        let earlier = now.addingTimeInterval(-3600).formatted(.iso8601)
        let list = try accounts("""
        [ { "id": "travail1", "label": "Travail 1", "connected": true,
            "usage": { "session": { "pct": 100, "resetsAt": "\(later)" }, "week": { "pct": 39 } } },
          { "id": "travail2", "label": "Travail 2", "connected": true,
            "usage": { "session": { "pct": 40 }, "week": { "pct": 20 } } },
          { "id": "perso", "label": "Perso", "connected": true,
            "usage": { "session": { "pct": 70, "resetsAt": "\(earlier)" }, "week": { "pct": 8 } } },
          { "id": "plein", "label": "Plein", "connected": true, "usage": { "session": { "pct": 5 }, "week": { "pct": 92 } } },
          { "id": "absent", "label": "Absent", "connected": false, "usage": { "session": { "pct": 0 }, "week": { "pct": 0 } } },
          { "id": "codex", "label": "ChatGPT", "kind": "codex", "connected": true } ]
        """)
        // Perso : sa session est remise à zéro (0 %), la plus petite ; une semaine à 92 % n'a plus de marge
        #expect(AccountSwitch.freeAccount(in: list, limited: "travail1", now: now)?.id == "perso")
        #expect(AccountSwitch.freeAccount(in: list, limited: "travail1", excluding: ["perso"], now: now)?.id == "travail2")
        #expect(AccountSwitch.freeAccount(in: list, limited: "travail1", excluding: ["perso", "travail2"], now: now) == nil)
    }

    @Test func aDuplicateOfTheLimitedAccountIsNeverProposed() throws {
        let list = try accounts("""
        [ { "id": "travail1", "label": "Travail 1", "connected": true, "sameAs": ["double"],
            "usage": { "session": { "pct": 100 }, "week": { "pct": 39 } } },
          { "id": "double", "label": "Double", "connected": true, "sameAs": ["travail1"],
            "usage": { "session": { "pct": 0 }, "week": { "pct": 0 } } } ]
        """)
        #expect(AccountSwitch.freeAccount(in: list, limited: "travail1", now: now) == nil)
    }

    @Test func theConfirmationSaysWhatTheSwitchCosts() throws {
        let perso = try #require(try accounts(#"[ { "id": "perso", "label": "Perso" } ]"#).first)
        let working = "Elle travaille : elle change de compte à la fin de son tour, ou tout de suite en l'interrompant (tu écris « continue » pour la reprendre)."
        // au repos : elle garde son historique, et relit toute la conversation sur le nouveau compte (la phrase du moteur)
        #expect(AccountSwitch.message(working: false, to: perso, contextTokens: 182_000)
                == "Elle garde tout son historique. Elle relira toute la conversation sur Perso (environ 182 k tokens).")
        #expect(AccountSwitch.message(working: false, to: perso, contextTokens: nil) == "Elle reprend sur Perso avec tout son historique.")
        #expect(AccountSwitch.message(working: false, to: perso, contextTokens: 0) == "Elle reprend sur Perso avec tout son historique.")
        // au travail : à la fin de son tour, ou tout de suite en l'interrompant
        #expect(AccountSwitch.message(working: true, to: perso, contextTokens: nil) == working)
        #expect(AccountSwitch.message(working: true, to: perso, contextTokens: 1_250_000)
                == "\(working) Elle relira toute la conversation sur Perso (environ \(Fmt.tokens(1_250_000)) tokens).")
        #expect(AccountSwitch.reread(on: perso, contextTokens: -5) == nil)
    }

    @Test func thePreviewLimitProposesPerso() async throws {
        let store = VigieStore(client: VigieClient(source: .fixtures(AbsenceTests.previewFolder)))
        await store.refreshOverview()
        let limit = try #require(store.toReview.first { $0.reviewKind == .limit })
        #expect(AccountSwitch.freeAccount(in: store.accounts, limited: limit.accountId, now: store.now)?.displayName == "Perso")
        // une conversation au repos, finie depuis moins de 24 h : son compte rendu, son verdict et ce qui te revient
        let portail = try #require(store.conversations.first { $0.shortTitle == "Portail" })
        let report = try #require(store.finishedReport(for: portail))
        #expect(report.toYou?.isEmpty == false && report.question?.isEmpty == false)
        #expect(portail.checks?.verdictKind == .changedAfterTests)
    }

    @Test func theVerdictKeepsItsColorAndIsNotRepeated() throws {
        let json = """
        { "verdict": "changedAfterTests", "label": "modifié après les tests", "uncommitted": 3,
          "notes": ["3 fichiers modifiés après le dernier commit"] }
        """
        let checks = try JSONDecoder().decode(RequestChecks.self, from: Data(json.utf8))
        let verdict = try #require(FinishedReportRow.verdict(checks))
        #expect(verdict.text == "modifié après les tests")
        #expect(verdict.color == Theme.warnText)
        #expect(FinishedReportRow.facts(detail: "3 commits · modifié après les tests · 3 fichiers modifiés après le dernier commit · déployé",
                                        checks: checks)
                == ["3 fichiers modifiés après le dernier commit", "3 commits", "déployé"])

        let verified = try JSONDecoder().decode(RequestChecks.self, from: Data(#"{ "verdict": "verified", "label": "tests verts après la dernière modification" }"#.utf8))
        #expect(FinishedReportRow.verdict(verified)?.color == nil)
        #expect(FinishedReportRow.verdict(verified)?.symbol == Icon.verified)
        let failed = try JSONDecoder().decode(RequestChecks.self, from: Data(#"{ "verdict": "testsFailed", "label": "tests en échec" }"#.utf8))
        #expect(FinishedReportRow.verdict(failed)?.color == Theme.alertText)
        // verdict inconnu de cette version : rien en couleur, les faits restent entiers
        let unknown = try JSONDecoder().decode(RequestChecks.self, from: Data(#"{ "verdict": "nouveau", "label": "autre chose" }"#.utf8))
        #expect(FinishedReportRow.verdict(unknown) == nil)
        #expect(FinishedReportRow.facts(detail: "2 commits · autre chose", checks: unknown) == ["2 commits", "autre chose"])
        #expect(FinishedReportRow.facts(detail: nil, checks: nil).isEmpty)
    }

    @Test func theWeekShareRedrawsWhenItsShownValueChanges() throws {
        let base = try JSONDecoder().decode(ConversationSummary.self, from: Data(#"{ "id": "c1", "weekPct": 14.2 }"#.utf8))
        func key(_ pct: Double?) -> [VigieStore.ScreenRow] {
            var c = base
            c.weekPct = pct
            return VigieStore.screenKey([c])
        }
        #expect(key(14.2) == key(13.8))   // « 14 % » des deux côtés
        #expect(key(14.2) != key(15.1))   // « 14 % » → « 15 % »
        #expect(key(0.4) == key(0.9))     // « < 1 % »
        #expect(key(0.9) != key(1.2))     // « < 1 % » → « 1 % »
        #expect(key(nil) != key(0.4))
    }
}

/// La ligne de faits d'une demande finie : le verdict des tests, ce qui n'est pas enregistré ou envoyé, et la coupe
/// quand la ligne est trop longue.
struct FinishedFactsTests {
    private func checks(_ json: String) throws -> RequestChecks {
        try JSONDecoder().decode(RequestChecks.self, from: Data(json.utf8))
    }

    @Test func aLongLineDropsWhatIsNotKeptFromTheEnd() {
        let line = FactLine(facts: [.init("4 commits"), .init("modifié après les tests", tone: .warn, kept: true),
                                    .init("38 fichiers"), .init("déployé"), .init("1 commit pas envoyé", tone: .warn, kept: true)])
        #expect(line.limited(to: 5) == line)
        #expect(line.limited(to: 9) == line)
        #expect(line.limited(to: 4).facts.map(\.text) == ["4 commits", "modifié après les tests", "38 fichiers", "1 commit pas envoyé"])
        #expect(line.limited(to: 3).facts.map(\.text) == ["4 commits", "modifié après les tests", "1 commit pas envoyé"])
        #expect(line.limited(to: 2).facts.map(\.text) == ["modifié après les tests", "1 commit pas envoyé"])
        // plus que des faits gardés : les premiers, dans leur ordre
        #expect(line.limited(to: 1).facts.map(\.text) == ["modifié après les tests"])
        #expect(line.limited(to: 0).isEmpty)
        // les tons ne bougent pas
        #expect(line.limited(to: 2).facts.allSatisfy { $0.tone == .warn && $0.kept })
    }

    @Test func theVerdictUsesTheEngineLabelElseOurs() throws {
        // la phrase du moteur, telle quelle, dans la couleur du verdict
        #expect(try checks(#"{ "verdict": "changedAfterTests", "label": "modifié après la dernière série de tests" }"#).verdictFact
                == .init("modifié après la dernière série de tests", tone: .warn, kept: true))
        // sans phrase (ou vide) : la nôtre
        #expect(try checks(#"{ "verdict": "verified" }"#).verdictFact
                == .init("tests verts après la dernière modification", tone: .checked, kept: true))
        #expect(try checks(#"{ "verdict": "changedAfterTests", "label": "  " }"#).verdictFact
                == .init("modifié après les tests", tone: .warn, kept: true))
        #expect(try checks(#"{ "verdict": "testsFailed" }"#).verdictFact == .init("tests en échec", tone: .alert, kept: true))
        #expect(try checks(#"{ "verdict": "noTests" }"#).verdictFact == .init("aucun test lancé", kept: true))
        // verdict inconnu de cette version : la phrase du moteur sans couleur ; sans phrase, rien
        #expect(try checks(#"{ "verdict": "nouveau", "label": "relu par quelqu'un" }"#).verdictFact == .init("relu par quelqu'un", kept: true))
        #expect(try checks(#"{ "verdict": "nouveau" }"#).verdictFact == nil)
        #expect(try checks("{}").verdictFact == nil)
    }

    @Test func notesComeFromTheEngineElseFromTheCounters() throws {
        // les phrases du moteur passent avant les compteurs (les vides sont écartées)
        let engine = try checks(#"{ "verdict": "verified", "uncommitted": 5, "notes": ["2 fichiers modifiés après le dernier commit", " ", "1 commit pas envoyé"] }"#)
        #expect(engine.noteFacts == [.init("2 fichiers modifiés après le dernier commit", tone: .warn, kept: true),
                                     .init("1 commit pas envoyé", tone: .warn, kept: true)])
        // sans phrases : les nôtres, déduites des compteurs, en orange
        let counted = try checks(#"{ "verdict": "verified", "uncommitted": 3, "unpushed": 2 }"#)
        #expect(counted.noteFacts.map(\.text) == ["3 fichiers modifiés après le dernier commit", "2 commits pas envoyés"])
        #expect(counted.noteFacts.allSatisfy { $0.tone == .warn && $0.kept })
        #expect(try checks(#"{ "uncommitted": 1, "unpushed": 1 }"#).noteFacts.map(\.text)
                == ["1 fichier modifié après le dernier commit", "1 commit pas envoyé"])
        // tout est enregistré et envoyé (0), ou jamais commité ni poussé (nil) : rien
        #expect(try checks(#"{ "uncommitted": 0, "unpushed": null }"#).noteFacts.isEmpty)
        // la ligne entière : le verdict d'abord, puis ce qui reste à faire
        #expect(counted.facts.map(\.text)
                == ["tests verts après la dernière modification", "3 fichiers modifiés après le dernier commit", "2 commits pas envoyés"])
        #expect(try checks(#"{ "verdict": "nouveau", "unpushed": 1 }"#).facts.map(\.text) == ["1 commit pas envoyé"])
    }
}
