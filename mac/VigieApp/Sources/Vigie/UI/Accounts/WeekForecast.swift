import Foundation

/// « Jusqu'où tient chaque compte » : au rythme des dernières 24 h, la semaine d'un compte serait pleine avant sa
/// remise à zéro (`usage.week.fullAt`, calculé par le moteur sur les vrais relevés du % de la semaine). La même phrase
/// sous la jauge Semaine (Comptes), dans l'aide d'un compte (barre latérale) et dans la barre des menus ; une
/// notification une seule fois par compte et par semaine.
/// Le moteur ne distingue pas « elle tient » de « rien à mesurer » (`fullAt` nul dans les deux cas) : sans date, rien
/// ne s'affiche. L'estimation est bruitée : « vers », à l'heure ronde.
enum WeekForecast {
    /// La date où la semaine serait pleine, si elle tombe entre maintenant et la remise à zéro ; nil sinon (rien de
    /// mesuré, déjà pleine, ou date après la remise à zéro).
    static func fullAt(_ week: UsageWindow?, now: Date) -> Date? {
        guard let week, let full = week.fullAt, full > now, (week.pct ?? 0) < 100 else { return nil }
        if let reset = week.resetsAt, full >= reset { return nil }
        return full
    }

    /// « À ce rythme : pleine vers jeu. 14 h, avant la remise à zéro de lun. 20:00 » ; nil s'il n'y a rien à dire.
    static func text(_ week: UsageWindow?, now: Date) -> String? {
        guard let full = fullAt(week, now: now) else { return nil }
        let head = "À ce rythme : pleine \(approx(full, now: now))"
        guard let reset = week?.resetsAt else { return head }
        return "\(head), avant la remise à zéro \(resetDay(reset, now: now))"
    }

    /// Titre de la notification : « Travail 1 sera plein avant la remise à zéro (vers jeu. 14 h) ». Le texte d'une
    /// notification est figé : toujours une heure, jamais « dans 25 min ».
    static func notificationTitle(account: String, week: UsageWindow?, now: Date) -> String? {
        guard let full = fullAt(week, now: now) else { return nil }
        return "\(account) sera plein avant la remise à zéro (\(approx(full, now: now, fixed: true)))"
    }

    /// « vers 14 h » aujourd'hui, « demain vers 14 h », « vers jeu. 14 h » ; « vers mar. 27 oct. 14 h » à 7 jours (le
    /// même jour de la semaine qu'aujourd'hui : le jour seul serait ambigu). Dans moins d'une heure : « dans 25 min »
    /// (« vers 14:15 » si `fixed`).
    static func approx(_ date: Date, now: Date, fixed: Bool = false) -> String {
        if date.timeIntervalSince(now) < 3600 {
            return fixed ? "vers \(Fmt.time(date))" : Fmt.remaining(until: date, now: now)
        }
        let calendar = Calendar.current
        let rounded = roundedHour(date, calendar: calendar)
        let hour = "\(calendar.component(.hour, from: rounded)) h"
        switch daysApart(now, rounded, calendar: calendar) {
        case 0: return "vers \(hour)"
        case 1: return "demain vers \(hour)"
        case let days: return "vers \(day(rounded, long: days >= 7)) \(hour)"
        }
    }

    /// « à 20:00 » aujourd'hui, « de demain 20:00 », « de lun. 20:00 » ; « de lun. 26 oct. 20:00 » à 7 jours.
    static func resetDay(_ date: Date, now: Date) -> String {
        let calendar = Calendar.current
        switch daysApart(now, date, calendar: calendar) {
        case ...0: return "à \(Fmt.time(date))"
        case 1: return "de demain \(Fmt.time(date))"
        case let days: return "de \(day(date, long: days >= 7)) \(Fmt.time(date))"
        }
    }

    /// L'heure ronde la plus proche (13:30 → 14 h, 14:15 → 14 h).
    private static func roundedHour(_ date: Date, calendar: Calendar) -> Date {
        let start = calendar.dateInterval(of: .hour, for: date)?.start ?? date
        return date.timeIntervalSince(start) >= 1800 ? calendar.date(byAdding: .hour, value: 1, to: start) ?? start : start
    }

    /// Nombre de jours du calendrier entre deux dates (0 : le même jour).
    private static func daysApart(_ from: Date, _ to: Date, calendar: Calendar) -> Int {
        calendar.dateComponents([.day], from: calendar.startOfDay(for: from), to: calendar.startOfDay(for: to)).day ?? 0
    }

    /// « jeu. », ou « jeu. 22 oct. ».
    private static func day(_ date: Date, long: Bool) -> String {
        long ? date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).locale(Fmt.locale))
             : date.formatted(.dateTime.weekday(.abbreviated).locale(Fmt.locale))
    }
}
