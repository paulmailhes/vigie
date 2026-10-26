import Foundation

/// Un MCP tel que saisi dans le formulaire (forme de Claude Code : stdio / http / sse).
struct MCPDraft: Equatable, Sendable {
    enum Transport: String, CaseIterable, Identifiable, Sendable {
        case stdio, http, sse
        var id: String { rawValue }
        var title: String {
            switch self {
            case .stdio: "Commande"
            case .http: "Adresse web"
            case .sse: "Ancien format (SSE)"
            }
        }
    }

    struct Pair: Equatable, Identifiable, Sendable {
        var id = UUID()
        var key: String = ""
        var value: String = ""
    }

    var name = ""
    var transport: Transport = .stdio
    var command = ""
    var arguments = ""
    var url = ""
    var env: [Pair] = []
    var headers: [Pair] = []
    /// user | project | local (portée demandée par une commande collée).
    var scope: String?

    /// Une valeur masquée par le moteur (« •••• ») ne doit jamais être renvoyée.
    var containsMaskedValue: Bool {
        let fields = [command, arguments, url] + env.map(\.value) + headers.map(\.value)
        return fields.contains { $0.contains("••••") }
    }

    var isComplete: Bool {
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        switch transport {
        case .stdio: return !command.trimmingCharacters(in: .whitespaces).isEmpty
        case .http, .sse: return URL(string: url.trimmingCharacters(in: .whitespaces))?.scheme != nil
        }
    }

    /// La configuration envoyée au moteur.
    var config: JSONValue {
        func object(_ pairs: [Pair]) -> JSONValue {
            var result: [String: JSONValue] = [:]
            for pair in pairs where !pair.key.trimmingCharacters(in: .whitespaces).isEmpty {
                result[pair.key.trimmingCharacters(in: .whitespaces)] = .string(pair.value)
            }
            return .object(result)
        }
        switch transport {
        case .stdio:
            return [
                "type": "stdio",
                "command": .string(command.trimmingCharacters(in: .whitespaces)),
                "args": .array(ShellWords.split(arguments).map(JSONValue.string)),
                "env": object(env),
            ]
        case .http, .sse:
            return [
                "type": .string(transport.rawValue),
                "url": .string(url.trimmingCharacters(in: .whitespaces)),
                "headers": object(headers),
            ]
        }
    }

    /// Préremplit le formulaire depuis la configuration renvoyée par le moteur (secrets masqués),
    /// sinon depuis la ligne affichée.
    static func from(name: String, type: String?, target: String?, config: MCPConfig?) -> MCPDraft {
        guard let config else { return from(name: name, type: type, target: target) }
        var draft = MCPDraft()
        draft.name = name
        draft.transport = Transport(rawValue: config.type ?? type ?? "") ?? (config.url != nil ? .http : .stdio)
        draft.command = config.command ?? ""
        draft.arguments = config.args.map(ShellWords.quote).joined(separator: " ")
        draft.url = config.url ?? ""
        draft.env = (config.env ?? [:]).sorted { $0.key < $1.key }.map { Pair(key: $0.key, value: $0.value) }
        draft.headers = (config.headers ?? [:]).sorted { $0.key < $1.key }.map { Pair(key: $0.key, value: $0.value) }
        return draft
    }

    /// Préremplit le formulaire à partir d'une ligne affichée par le moteur (cible masquée).
    static func from(name: String, type: String?, target: String?) -> MCPDraft {
        var draft = MCPDraft()
        draft.name = name
        draft.transport = Transport(rawValue: type ?? "") ?? .stdio
        let text = target ?? ""
        switch draft.transport {
        case .stdio:
            let words = ShellWords.split(text)
            draft.command = words.first ?? ""
            draft.arguments = words.dropFirst().map(ShellWords.quote).joined(separator: " ")
        case .http, .sse:
            draft.url = text
        }
        return draft
    }
}

enum MCPCommandParser {
    enum Failure: Error, Equatable {
        case notACommand
        case missingName
        case missingTarget
        case badJSON
    }

    /// Analyse « claude mcp add [options] <nom> <commande ou URL> [args…] »
    /// ou « claude mcp add-json <nom> '<json>' ».
    static func parse(_ text: String) -> Result<MCPDraft, Failure> {
        let joined = text.replacing("\\\n", with: " ").replacing("\n", with: " ")
        var words = ShellWords.split(joined)
        guard let start = words.firstIndex(where: { $0 == "mcp" }),
              start + 1 < words.count else { return .failure(.notACommand) }
        let verb = words[start + 1]
        words = Array(words[(start + 2)...])
        switch verb {
        case "add": return parseAdd(words)
        case "add-json": return parseAddJSON(words)
        default: return .failure(.notACommand)
        }
    }

    private static func parseAdd(_ words: [String]) -> Result<MCPDraft, Failure> {
        var draft = MCPDraft()
        var positional: [String] = []
        var transportGiven: MCPDraft.Transport?
        var index = 0
        var afterSeparator = false
        while index < words.count {
            let word = words[index]
            if afterSeparator {
                positional.append(word)
                index += 1
                continue
            }
            func next() -> String? {
                index += 1
                return index < words.count ? words[index] : nil
            }
            func valueOf(_ option: String) -> String? {
                if let equal = word.firstIndex(of: "="), word.hasPrefix(option + "=") {
                    return String(word[word.index(after: equal)...])
                }
                return nil
            }
            switch true {
            case word == "--":
                afterSeparator = true
            case word == "-t" || word == "--transport":
                transportGiven = next().flatMap(MCPDraft.Transport.init(rawValue:))
            case word.hasPrefix("--transport="):
                transportGiven = valueOf("--transport").flatMap(MCPDraft.Transport.init(rawValue:))
            case word == "-s" || word == "--scope":
                draft.scope = next()
            case word.hasPrefix("--scope="):
                draft.scope = valueOf("--scope")
            case word == "-e" || word == "--env":
                if let pair = next() { draft.env.append(splitPair(pair, separator: "=")) }
            case word.hasPrefix("--env="):
                if let pair = valueOf("--env") { draft.env.append(splitPair(pair, separator: "=")) }
            case word == "-H" || word == "--header":
                if let pair = next() { draft.headers.append(splitPair(pair, separator: ":")) }
            case word.hasPrefix("--header="):
                if let pair = valueOf("--header") { draft.headers.append(splitPair(pair, separator: ":")) }
            case word.hasPrefix("-") && positional.count < 2:
                break // option inconnue : ignorée
            default:
                positional.append(word)
            }
            index += 1
        }
        guard let name = positional.first else { return .failure(.missingName) }
        guard positional.count >= 2 else { return .failure(.missingTarget) }
        draft.name = name
        let target = positional[1]
        let looksLikeURL = target.hasPrefix("http://") || target.hasPrefix("https://")
        draft.transport = transportGiven ?? (looksLikeURL ? .http : .stdio)
        if draft.transport == .stdio {
            draft.command = target
            draft.arguments = positional.dropFirst(2).map(ShellWords.quote).joined(separator: " ")
        } else {
            draft.url = target
        }
        return .success(draft)
    }

    private static func parseAddJSON(_ words: [String]) -> Result<MCPDraft, Failure> {
        let positional = words.filter { !$0.hasPrefix("-") }
        guard let name = positional.first else { return .failure(.missingName) }
        guard positional.count >= 2, let data = positional[1].data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .failure(.badJSON)
        }
        var draft = MCPDraft()
        draft.name = name
        if let scopeIndex = words.firstIndex(where: { $0 == "-s" || $0 == "--scope" }), scopeIndex + 1 < words.count {
            draft.scope = words[scopeIndex + 1]
        }
        let type = object["type"] as? String
        draft.transport = MCPDraft.Transport(rawValue: type ?? "") ?? (object["url"] != nil ? .http : .stdio)
        draft.command = object["command"] as? String ?? ""
        draft.arguments = (object["args"] as? [String] ?? []).map(ShellWords.quote).joined(separator: " ")
        draft.url = object["url"] as? String ?? ""
        draft.env = (object["env"] as? [String: String] ?? [:]).sorted { $0.key < $1.key }
            .map { MCPDraft.Pair(key: $0.key, value: $0.value) }
        draft.headers = (object["headers"] as? [String: String] ?? [:]).sorted { $0.key < $1.key }
            .map { MCPDraft.Pair(key: $0.key, value: $0.value) }
        return .success(draft)
    }

    private static func splitPair(_ text: String, separator: Character) -> MCPDraft.Pair {
        guard let index = text.firstIndex(of: separator) else { return MCPDraft.Pair(key: text, value: "") }
        let key = text[..<index].trimmingCharacters(in: .whitespaces)
        let value = text[text.index(after: index)...].trimmingCharacters(in: .whitespaces)
        return MCPDraft.Pair(key: key, value: value)
    }
}

/// Découpage d'une ligne de commande façon shell (guillemets simples et doubles, barre oblique inverse).
enum ShellWords {
    static func split(_ text: String) -> [String] {
        var words: [String] = []
        var current = ""
        var inWord = false
        var quote: Character?
        var escaping = false
        for character in text {
            if escaping {
                current.append(character)
                escaping = false
                inWord = true
                continue
            }
            if character == "\\" && quote != "'" {
                escaping = true
                continue
            }
            if let open = quote {
                if character == open {
                    quote = nil
                } else {
                    current.append(character)
                }
                continue
            }
            if character == "'" || character == "\"" {
                quote = character
                inWord = true
                continue
            }
            if character.isWhitespace {
                if inWord {
                    words.append(current)
                    current = ""
                    inWord = false
                }
                continue
            }
            current.append(character)
            inWord = true
        }
        if inWord { words.append(current) }
        return words
    }

    static func quote(_ word: String) -> String {
        guard word.isEmpty || word.contains(where: { $0.isWhitespace || $0 == "'" || $0 == "\"" }) else { return word }
        return "'" + word.replacing("'", with: "'\\''") + "'"
    }
}
