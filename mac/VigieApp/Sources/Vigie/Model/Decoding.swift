import Foundation

// Décodage tolérant : le moteur peut omettre un champ, envoyer null, ou une date avec ou sans
// fractions de seconde. Un élément illisible dans une liste est ignoré au lieu de tout faire échouer.

enum ISODates {
    private static let withFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let plain = Date.ISO8601FormatStyle()

    static func parse(_ raw: String) -> Date? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if let date = try? Date(text, strategy: withFraction) { return date }
        if let date = try? Date(text, strategy: plain) { return date }
        // Décalage horaire explicite (« +02:00 ») : formateur plus permissif.
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: text)
    }
}

/// Date ISO 8601 (avec ou sans fractions), ou nombre de secondes / millisecondes. Jamais d'erreur.
@propertyWrapper
struct FlexDate: Decodable, Equatable, Sendable {
    var wrappedValue: Date?

    init(wrappedValue: Date?) { self.wrappedValue = wrappedValue }

    init(from decoder: any Decoder) throws {
        guard let container = try? decoder.singleValueContainer(), !container.decodeNil() else {
            wrappedValue = nil
            return
        }
        if let text = try? container.decode(String.self) {
            wrappedValue = ISODates.parse(text)
        } else if let number = try? container.decode(Double.self) {
            wrappedValue = Date(timeIntervalSince1970: number > 100_000_000_000 ? number / 1000 : number)
        } else {
            wrappedValue = nil
        }
    }
}

/// Texte ou nombre (un pid peut arriver en nombre) ; illisible = nil.
@propertyWrapper
struct FlexString: Decodable, Equatable, Sendable {
    var wrappedValue: String?

    init(wrappedValue: String?) { self.wrappedValue = wrappedValue }

    init(from decoder: any Decoder) throws {
        guard let container = try? decoder.singleValueContainer(), !container.decodeNil() else {
            wrappedValue = nil
            return
        }
        if let text = try? container.decode(String.self) {
            wrappedValue = text.isEmpty ? nil : text
        } else if let number = try? container.decode(Int.self) {
            wrappedValue = String(number)
        } else if let number = try? container.decode(Double.self) {
            wrappedValue = String(Int(number))
        } else {
            wrappedValue = nil
        }
    }
}

/// Liste dont les éléments illisibles sont ignorés ; absente ou null = liste vide.
@propertyWrapper
struct Lossy<Element: Decodable & Equatable & Sendable>: Decodable, Equatable, Sendable {
    var wrappedValue: [Element]

    init(wrappedValue: [Element] = []) { self.wrappedValue = wrappedValue }

    private struct Skip: Decodable {
        init(from decoder: any Decoder) throws {}
    }

    init(from decoder: any Decoder) throws {
        guard var container = try? decoder.unkeyedContainer() else {
            wrappedValue = []
            return
        }
        var items: [Element] = []
        while !container.isAtEnd {
            if let item = try? container.decode(Element.self) {
                items.append(item)
            } else if (try? container.decode(Skip.self)) == nil {
                break
            }
        }
        wrappedValue = items
    }
}

/// Objet facultatif : illisible = nil, sans faire échouer le reste.
@propertyWrapper
struct Tolerant<Value: Decodable & Equatable & Sendable>: Decodable, Equatable, Sendable {
    var wrappedValue: Value?

    init(wrappedValue: Value?) { self.wrappedValue = wrappedValue }

    init(from decoder: any Decoder) throws {
        wrappedValue = try? Value(from: decoder)
    }
}

extension KeyedDecodingContainer {
    func decode(_ type: FlexDate.Type, forKey key: Key) throws -> FlexDate {
        (try? decodeIfPresent(type, forKey: key)) ?? FlexDate(wrappedValue: nil)
    }

    func decode(_ type: FlexString.Type, forKey key: Key) throws -> FlexString {
        (try? decodeIfPresent(type, forKey: key)) ?? FlexString(wrappedValue: nil)
    }

    func decode<Element>(_ type: Lossy<Element>.Type, forKey key: Key) throws -> Lossy<Element> {
        (try? decodeIfPresent(type, forKey: key)) ?? Lossy(wrappedValue: [])
    }

    func decode<Value>(_ type: Tolerant<Value>.Type, forKey key: Key) throws -> Tolerant<Value> {
        (try? decodeIfPresent(type, forKey: key)) ?? Tolerant(wrappedValue: nil)
    }
}

/// Une chaîne ou une liste de chaînes (réponse multiple à une question).
struct StringList: Decodable, Equatable, Sendable {
    var values: [String]

    init(_ values: [String]) { self.values = values }

    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let one = try? container.decode(String.self) {
            values = [one]
        } else if let many = try? container.decode([String].self) {
            values = many
        } else {
            values = []
        }
    }
}

/// Corps JSON des écritures (POST), construit sans dictionnaire non typé.
enum JSONValue: Encodable, Sendable, Equatable,
    ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral, ExpressibleByNilLiteral {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case array([JSONValue])
    case object([String: JSONValue])
    case null

    init(stringLiteral value: String) { self = .string(value) }
    init(booleanLiteral value: Bool) { self = .bool(value) }
    init(integerLiteral value: Int) { self = .int(value) }
    init(nilLiteral: ()) { self = .null }
    init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    init(dictionaryLiteral elements: (String, JSONValue)...) {
        self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last }))
    }

    static func optional(_ value: Bool?) -> JSONValue { value.map(JSONValue.bool) ?? .null }
    static func optional(_ value: String?) -> JSONValue { value.map(JSONValue.string) ?? .null }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .int(let value): try container.encode(value)
        case .double(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}
