import Foundation
import SwiftUI
import Testing
@testable import Vigie

/// Graphique « Consommation » (page Comptes) : fenêtres de 1 h à 48 h, conversations fermées qui restent affichées.
@MainActor
struct UsageChartTests {
    /// Les données d'exemple du dépôt (mac/VigieApp/Preview).
    private static var previewFolder: URL {
        URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Preview", directoryHint: .isDirectory)
    }

    /// Conversation fermée des données d'exemple (« Analyse : pourquoi atelier perd des joueurs », arrêtée à 16:11).
    private static let closedID = "e5f6a7b8-c9d0-4e1f-a2b3-c4d5e6f7a8b9"

    private func demoStore() async -> VigieStore {
        let store = VigieStore(client: VigieClient(source: .fixtures(Self.previewFolder)))
        await store.refreshOverview()
        return store
    }

    @Test func fourWindowsFromOneHourToTwoDays() {
        #expect(UsageSpan.allCases.map(\.rawValue) == [60, 600, 1440, 2880])
        #expect(UsageSpan.allCases.map(\.label) == ["1 h", "10 h", "24 h", "48 h"])
        // 60 points par fenêtre : un pas de 1, 10, 24 et 48 min
        #expect(UsageSpan.allCases.map(\.defaultStep) == [1, 10, 24, 48])
        #expect(UsageSpan.allCases.map(\.spansDays) == [false, false, true, true])
    }

    @Test func aWindowNoLongerOfferedFallsBackToTheClosestOne() {
        // 20 h, retenue par Vigie 0.3.28 et avant : 24 h
        #expect(UsageSpan(stored: 1200) == .day)
        for span in UsageSpan.allCases { #expect(UsageSpan(stored: span.rawValue) == span) }
        #expect(UsageSpan(stored: 0) == .hour)
        #expect(UsageSpan(stored: 30) == .hour)
        #expect(UsageSpan(stored: 99_999) == .twoDays)
    }

    @Test func demoModeHasEveryWindow() throws {
        for span in UsageSpan.allCases {
            let name = VigieClient.fixtureName(for: "/api/v2/usage/series?window=\(span.rawValue)")
            let data = try Data(contentsOf: Self.previewFolder.appending(path: name))
            let series = try JSONDecoder().decode(UsageSeries.self, from: data)
            #expect(series.stepMin == span.defaultStep, "\(name)")
            #expect(series.conversations.allSatisfy { $0.points.count == 60 }, "\(name)")
        }
    }

    @Test func closedConversationsStayOnTheChart() async throws {
        let store = await demoStore()
        // 1 h : elle s'est arrêtée il y a 7 h, rien à montrer
        await store.refreshUsageSeries(.hour)
        let hour = try #require(store.usageSeries[UsageSpan.hour.rawValue])
        #expect(!hour.conversations.contains { $0.id == Self.closedID })
        for span in [UsageSpan.tenHours, .day, .twoDays] {
            await store.refreshUsageSeries(span)
            let series = try #require(store.usageSeries[span.rawValue], "\(span.label)")
            let lines = UsageLine.make(series, store: store, span: span, cumulative: false)
            let closed = try #require(lines.first { $0.id == Self.closedID }, "\(span.label)")
            #expect(!closed.running && closed.lastActivity != nil, "\(span.label)")
            #expect(closed.totalPct > 0, "\(span.label)")
            #expect(!closed.stroke.dash.isEmpty, "pointillés pour une fermée")
            #expect(lines.filter(\.running).allSatisfy { $0.stroke.dash.isEmpty }, "trait plein pour une ouverte")
            // sa courbe s'arrête juste après son dernier appel (16:11), un point à zéro pour la chute ; les ouvertes
            // vont jusqu'au bout de la fenêtre
            let stop = try #require(closed.lastActivity).addingTimeInterval(span.defaultStep * 60)
            let end = try #require(closed.points.last)
            #expect(end.value == 0 && end.t <= stop, "\(span.label)")
            #expect(closed.points.count < 60, "\(span.label)")
            #expect(lines.filter(\.running).allSatisfy { $0.points.count == 60 }, "\(span.label)")
            // au survol après sa fin, plus de valeur : l'infobulle dit qu'elle est fermée et quand
            let window = try #require(series.window)
            #expect(closed.point(near: window.upperBound) == nil, "\(span.label)")
            #expect(closed.point(near: end.t) != nil, "\(span.label)")
            let rows = UsageLine.tooltipRows(lines, at: window.upperBound)
            let after = try #require(rows.first { $0.line.id == Self.closedID }, "\(span.label)")
            #expect(after.point == nil && after.line.closedAt == closed.lastActivity, "\(span.label)")
            #expect(rows.last?.line.id == Self.closedID, "les fermées après les valeurs, \(span.label)")
            // à 0,9 % de la semaine (vue d'ensemble), elle passe dans « Autres », qui le dit ; une fermée plus
            // gourmande garde sa couleur (othersSaysHowManyAreClosed)
            let chart = UsageLine.forChart(lines)
            #expect(chart.count <= UsageLine.maxLines)
            #expect(chart.contains { $0.id == Self.closedID && !$0.running }
                    || chart.contains { $0.id == "autres" && ($0.subtitle ?? "").contains("dont 1 fermée") }, "\(span.label)")
            // deux conversations d'Atelier : chacune se nomme par son titre
            #expect(Set(lines.map(\.name)).count == lines.count, "\(span.label)")
            #expect(closed.name == "Analyse : pourquoi atelier perd des joueurs")
        }
    }

    @Test func aConversationKeepsItsNameOnEveryWindow() async throws {
        let store = await demoStore()
        var names: [String: Set<String>] = [:]
        for span in UsageSpan.allCases {
            await store.refreshUsageSeries(span)
            let series = try #require(store.usageSeries[span.rawValue], "\(span.label)")
            for line in UsageLine.make(series, store: store, span: span, cumulative: false) {
                names[line.id, default: []].insert(line.name)
            }
        }
        // l'ouverte d'Atelier est seule sur 1 h (la fermée n'a rien consommé dans l'heure) : même nom que sur 48 h
        #expect(names["b1b9b451-c53c-439e-b804-3689257268e3"] == ["Refaire le site Horizon complet"])
        #expect(names.values.allSatisfy { $0.count == 1 }, "\(names)")
        // les autres gardent leur nom de projet, comme dans le reste de Vigie
        #expect(names["9a7f3c21-5b8e-4d0a-a6f2-3e1c8b7d4f60"] == ["Portail/back"])
        #expect(names["4e0c8a7d-2f61-4b8e-9c3a-7d5e1f0b9a24"] == ["Boutique"])
    }

    @Test func demoSeriesStayWithinTheAccountsWeeks() async throws {
        let store = await demoStore()
        await store.refreshAccounts()
        var previous: [String: Double] = [:]
        for span in UsageSpan.allCases {
            await store.refreshUsageSeries(span)
            let series = try #require(store.usageSeries[span.rawValue], "\(span.label)")
            // jamais plus que la semaine du compte (Perso 8 %, Travail 1 39 %)
            for account in series.accounts {
                let week = try #require(store.account(account.id)?.usage?.week?.pct, "\(account.id)")
                #expect(account.totalPct <= week + 0.01, "\(account.id) sur \(span.label)")
                let conversations = series.conversations.filter { $0.accountId == account.id }
                #expect(abs(conversations.reduce(0) { $0 + $1.totalPct } - account.totalPct) < 0.01, "\(account.id) sur \(span.label)")
            }
            // une conversation ne consomme jamais moins sur une période plus longue
            for conversation in series.conversations {
                #expect(conversation.totalPct >= (previous[conversation.id] ?? 0) - 0.01, "\(conversation.id) sur \(span.label)")
                previous[conversation.id] = conversation.totalPct
            }
            // et ne dépasse pas sa part de semaine dans la vue d'ensemble sur un compte dont la semaine a commencé
            // avant la fenêtre (Perso : toute sa consommation est du 19)
            for conversation in series.conversations where conversation.accountId == "perso" {
                let week = try #require(store.conversation(conversation.id)?.weekPct, "\(conversation.id)")
                #expect(conversation.totalPct <= week + 0.01, "\(conversation.id) sur \(span.label)")
            }
        }
        // sur 24 h comme sur 48 h, Perso a consommé toute sa semaine, et rien d'autre
        #expect(abs((previous.filter { id, _ in store.conversation(id)?.accountId == "perso" }.values.reduce(0, +)) - 8) < 0.02)
    }

    @Test func theTooltipIsNeverEmpty() {
        // le matin, aucune conversation ouverte, 10 h : deux fermées arrêtées dans la nuit
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        func closed(_ id: String, stopAfter minutes: Int) -> UsageLine {
            let points = stride(from: 0, through: minutes, by: 10).enumerated().map { index, minute in
                UsageLine.Point(id: index, t: start.addingTimeInterval(Double(minute) * 60),
                                value: minute == minutes ? 0 : 1, tokens: minute == minutes ? 0 : 1000)
            }
            return UsageLine(id: id, name: id, subtitle: nil, account: nil, color: .blue, running: false,
                             lastActivity: start.addingTimeInterval(Double(minutes - 5) * 60),
                             totalPct: 1, totalTokens: 1000, points: points)
        }
        let lines = [closed("a", stopAfter: 120), closed("b", stopAfter: 200)]
        let morning = start.addingTimeInterval(9 * 3600)
        let rows = UsageLine.tooltipRows(lines, at: morning)
        // chacune dit qu'elle est fermée (la plus récente d'abord), aucune valeur inventée
        #expect(rows.map(\.line.id) == ["b", "a"])
        #expect(rows.allSatisfy { $0.point == nil })
        // pendant qu'elles travaillaient : leur valeur
        #expect(UsageLine.tooltipRows(lines, at: start.addingTimeInterval(30 * 60)).allSatisfy { $0.point?.value == 1 })
        // une ouverte n'est jamais « fermée »
        var open = closed("c", stopAfter: 120)
        open.running = true
        #expect(open.closedAt == nil)
        #expect(UsageLine.tooltipRows([open], at: morning).isEmpty)
    }

    @Test func aClosedConversationStaysForTheWindowShown() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        for span in UsageSpan.allCases {
            let note = UsageLine.closedNote(lastActivity: now.addingTimeInterval(-600), span: span, now: now)
            #expect(note.contains("tant qu'elle a consommé dans la période affichée (\(span.label))"), "\(note)")
            #expect(!note.contains("48 h") || span == .twoDays, "\(note)")
        }
    }

    @Test func othersSaysHowManyAreClosed() {
        func line(_ id: String, _ pct: Double, running: Bool) -> UsageLine {
            UsageLine(id: id, name: id, subtitle: nil, account: nil, color: .gray, running: running, lastActivity: nil,
                      totalPct: pct, totalTokens: 0,
                      points: [UsageLine.Point(id: 0, t: Date(timeIntervalSince1970: 0), value: pct, tokens: 0)])
        }
        let lines = [line("a", 9, running: true), line("b", 8, running: true), line("c", 7, running: false),
                     line("d", 6, running: true), line("e", 2, running: false), line("f", 1, running: false),
                     line("g", 0.5, running: true)]
        let chart = UsageLine.forChart(lines)
        #expect(chart.map(\.id) == ["a", "b", "c", "d", "autres"])
        #expect(chart.last?.subtitle == "3 conversations dont 2 fermées")
        #expect(chart.last?.totalPct == 3.5)
        // la fermée gourmande garde sa couleur, jamais le gris d'« Autres »
        #expect(chart.first { $0.id == "c" }?.color != .gray)
    }
}
