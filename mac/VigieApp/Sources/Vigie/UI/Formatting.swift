import Foundation

/// Formats en français, heure locale.
enum Fmt {
    static let locale = Locale(identifier: "fr_FR")

    static func time(_ date: Date) -> String {
        date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).locale(locale))
    }

    private static func day(_ date: Date) -> String {
        date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).locale(locale))
    }

    /// « 02:14 » aujourd'hui, « hier 18:39 », sinon « lun. 26 oct. 20:00 ».
    static func when(_ date: Date?, now: Date = .now) -> String {
        guard let date else { return "" }
        let calendar = Calendar.current
        if calendar.isDate(date, inSameDayAs: now) { return time(date) }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return "hier \(time(date))"
        }
        return "\(day(date)) \(time(date))"
    }

    /// Date et heure exactes de remise à zéro : « lun. 26 oct. à 20:00 », « aujourd'hui à 03:40 ».
    static func reset(_ date: Date, now: Date = .now) -> String {
        let calendar = Calendar.current
        if calendar.isDate(date, inSameDayAs: now) { return "aujourd'hui à \(time(date))" }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: tomorrow) {
            return "demain à \(time(date))"
        }
        return "\(day(date)) à \(time(date))"
    }

    /// « à l'instant », « il y a 12 min », « il y a 3 h », « il y a 2 j ».
    static func ago(_ date: Date?, now: Date = .now) -> String {
        guard let date else { return "" }
        let seconds = max(0, now.timeIntervalSince(date))
        switch seconds {
        case ..<60: return "à l'instant"
        case ..<3600: return "il y a \(Int(seconds / 60)) min"
        case ..<86_400: return "il y a \(Int(seconds / 3600)) h"
        default: return "il y a \(Int(seconds / 86_400)) j"
        }
    }

    /// « 21 s », « 42 min », « 1 h 05 », « 8 h ».
    static func duration(ms: Double?) -> String {
        guard let ms, ms > 0 else { return "" }
        let seconds = Int(ms / 1000)
        if seconds < 60 { return "\(seconds) s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes) min" }
        let hours = minutes / 60
        let rest = minutes % 60
        if hours >= 10 || rest == 0 { return "\(hours) h" }
        return "\(hours) h \(rest < 10 ? "0" : "")\(rest)"
    }

    static func int(_ value: Int?) -> String {
        (value ?? 0).formatted(.number.locale(locale))
    }

    static func pct(_ value: Double?) -> String {
        guard let value else { return "–" }
        let rounded = value >= 10 || value == value.rounded() ? value.rounded() : (value * 10).rounded() / 10
        return "\(rounded.formatted(.number.locale(locale))) %"
    }

    /// « 182 k », « 1,2 M ».
    static func tokens(_ value: Int) -> String {
        if value >= 1_000_000 {
            return "\((Double(value) / 1_000_000).formatted(.number.precision(.fractionLength(0...1)).locale(locale))) M"
        }
        return "\(Int((Double(value) / 1000).rounded())) k"
    }

    /// « /Users/alex/Code/atelier » → « ~/Code/atelier ».
    static func shortPath(_ path: String) -> String {
        var home = FileManager.default.homeDirectoryForCurrentUser.path(percentEncoded: false)
        if home.hasSuffix("/") { home.removeLast() }
        guard !home.isEmpty, path == home || path.hasPrefix(home + "/") else { return path }
        return "~" + path.dropFirst(home.count)
    }

    /// Accord simple : « 1 agent », « 3 agents ».
    static func count(_ value: Int, _ singular: String, _ plural: String? = nil) -> String {
        "\(int(value)) \(value > 1 ? (plural ?? singular + "s") : singular)"
    }
}
