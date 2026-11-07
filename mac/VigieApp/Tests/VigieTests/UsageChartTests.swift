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
            // au survol après sa fermée, elle ne dit plus rien
            let window = try #require(series.window)
            #expect(closed.point(near: window.upperBound) == nil, "\(span.label)")
            #expect(closed.point(near: end.t) != nil, "\(span.label)")
            // assez gourmande pour garder sa couleur et son « fermée » dans la légende
            let chart = UsageLine.forChart(lines)
            #expect(chart.count <= UsageLine.maxLines)
            #expect(chart.contains { $0.id == Self.closedID && !$0.running }, "\(span.label)")
            // deux conversations d'Atelier : chacune se nomme par son titre
            #expect(Set(lines.map(\.name)).count == lines.count, "\(span.label)")
            #expect(closed.name == "Analyse : pourquoi atelier perd des joueurs")
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
