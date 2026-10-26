import Foundation
import Synchronization

/// Jeton d'accès à l'API, posé par le moteur dans ~/.vigie/data/api-token (VIGIE_TOKEN_FILE pour les essais) :
/// sans lui, le moteur refuse tout sauf son état de santé. Relu quand le moteur le refuse (moteur réinstallé).
enum APIToken {
    static let file: URL = {
        if let path = ProcessInfo.processInfo.environment["VIGIE_TOKEN_FILE"], !path.isEmpty {
            return URL(filePath: (path as NSString).expandingTildeInPath)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appending(path: ".vigie/data/api-token")
    }()
    private static let cache = Mutex<String?>(nil)

    static func current(reload: Bool = false) -> String? {
        cache.withLock { value in
            if value == nil || reload {
                value = (try? String(contentsOf: file, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            return value
        }
    }
}

enum ClientError: Error, Sendable, Equatable {
    /// Le moteur ne répond pas (connexion refusée, délai dépassé…).
    case unreachable
    /// Réponse refusée par le moteur, avec sa phrase d'erreur.
    case refused(String)
    /// Réponse illisible.
    case unreadable
    /// Fichier de démonstration manquant.
    case missingFixture(String)

    var message: String {
        switch self {
        case .unreachable: "Le moteur de Vigie ne répond pas"
        case .refused(let text): text
        case .unreadable: "Réponse illisible du moteur de Vigie : réessaie"
        case .missingFixture(let name): "Fichier de démonstration absent : \(name)"
        }
    }
}

/// Accès au moteur : réseau (API v2) ou dossier de démonstration (VIGIE_FIXTURES).
struct VigieClient: Sendable {
    enum Source: Sendable {
        case network(URL)
        case fixtures(URL)
    }

    let source: Source

    var isDemo: Bool {
        if case .fixtures = source { return true }
        return false
    }

    static func fromEnvironment(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> VigieClient {
        if let folder = environment["VIGIE_FIXTURES"], !folder.isEmpty {
            return VigieClient(source: .fixtures(URL(filePath: (folder as NSString).expandingTildeInPath, directoryHint: .isDirectory)))
        }
        let raw = environment["VIGIE_API"].flatMap { $0.isEmpty ? nil : $0 } ?? "http://127.0.0.1:4777"
        let base = URL(string: raw.hasSuffix("/") ? String(raw.dropLast()) : raw) ?? URL(filePath: "/")
        return VigieClient(source: .network(base))
    }

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 10
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }()

    // MARK: Lecture

    @concurrent
    func get<T: Decodable & Sendable>(_ path: String, as type: T.Type = T.self) async throws -> T {
        let data: Data
        switch source {
        case .fixtures(let folder):
            let name = Self.fixtureName(for: path)
            let url = folder.appending(path: name)
            guard let contents = try? Data(contentsOf: url) else { throw ClientError.missingFixture(name) }
            data = contents
        case .network(let base):
            guard let url = URL(string: base.absoluteString + path) else { throw ClientError.unreachable }
            var request = URLRequest(url: url)
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            data = try await Self.send(request)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ClientError.unreadable
        }
    }

    static func fixtureName(for path: String) -> String {
        let trimmed = path.split(separator: "?").first.map(String.init) ?? path
        let parts = trimmed.split(separator: "/").map(String.init)
        // /api/v2/<route>[/<id>]
        let route = parts.dropFirst(2)
        switch route.first {
        case "conversation":
            let id = route.dropFirst().first ?? ""
            return "conversation-\(id).json"
        case "usage":
            // /api/v2/usage/series?window=60 → usage-series-60.json
            let query = path.split(separator: "?").dropFirst().first.map(String.init) ?? ""
            let window = query.split(separator: "&")
                .first { $0.hasPrefix("window=") }
                .map { String($0.dropFirst("window=".count)) } ?? "60"
            return "usage-\(route.dropFirst().first ?? "series")-\(window).json"
        case let name?:
            return "\(name).json"
        case nil:
            return "overview.json"
        }
    }

    // MARK: Écriture

    @concurrent
    func post(_ path: String, _ body: JSONValue) async throws -> WriteResult {
        switch source {
        case .fixtures:
            return DemoWrites.answer(path: path, body: body)
        case .network(let base):
            guard let url = URL(string: base.absoluteString + path) else { throw ClientError.unreachable }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("1", forHTTPHeaderField: "X-Vigie")
            request.httpBody = try? JSONEncoder().encode(body)
            let data = try await Self.send(request, acceptErrorBody: true)
            guard let result = try? JSONDecoder().decode(WriteResult.self, from: data) else {
                throw ClientError.unreadable
            }
            if result.ok == false { throw ClientError.refused(result.error ?? "Le moteur de Vigie a refusé cette action") }
            return result
        }
    }

    // MARK: Réseau

    private static func send(_ request: URLRequest, acceptErrorBody: Bool = false) async throws -> Data {
        var (data, http) = try await exchange(request, token: APIToken.current())
        if http.statusCode == 401, let fresh = APIToken.current(reload: true) {
            (data, http) = try await exchange(request, token: fresh)
        }
        if (200..<300).contains(http.statusCode) { return data }
        if http.statusCode == 401 { throw ClientError.refused("Vigie n'a plus accès à son moteur : quitte Vigie et rouvre-le") }
        if acceptErrorBody, (400..<500).contains(http.statusCode) {
            if let result = try? JSONDecoder().decode(WriteResult.self, from: data), let error = result.error {
                throw ClientError.refused(error)
            }
        }
        if http.statusCode == 404 { throw ClientError.refused("Le moteur de Vigie est trop ancien pour ça : mets Vigie à jour (Réglages › Mises à jour)") }
        if http.statusCode == 403 { throw ClientError.refused("Le moteur de Vigie a refusé la modification") }
        throw ClientError.refused("Le moteur de Vigie a eu un problème (\(http.statusCode)) : réessaie dans un instant")
    }

    private static func exchange(_ request: URLRequest, token: String?) async throws -> (Data, HTTPURLResponse) {
        var request = request
        if let token { request.setValue(token, forHTTPHeaderField: "X-Vigie-Token") }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw ClientError.unreachable
        }
        guard let http = response as? HTTPURLResponse else { throw ClientError.unreadable }
        return (data, http)
    }
}

/// Mode démonstration : les écritures réussissent sans rien modifier.
enum DemoWrites {
    static func answer(path: String, body: JSONValue) -> WriteResult {
        if path.hasPrefix("/api/v2/questions/"), case .object(let fields) = body,
           fields["action"] == .string("change"), case .object(let answers)? = fields["answers"] {
            let lines = answers.sorted { $0.key < $1.key }.compactMap { question, answer -> String? in
                guard case .string(let label) = answer else { return nil }
                return "Pour « \(question) », je préfère « \(label) »."
            }
            let text = (lines + ["Reprends avec ce choix, s'il te plaît."]).joined(separator: " ")
            return WriteResult(ok: true, correction: text, delivered: false)
        }
        if path == "/api/v2/approvals", case .object(let fields) = body {
            if fields["decision"] == .string("deny") { return WriteResult(ok: true) }
            return WriteResult(ok: true, delivered: false,
                               message: "L'utilisateur a autorisé : l'action sensible en attente. Relance-la à l'identique.")
        }
        if path.contains("/settings"), case .object(let fields) = body, fields["accountId"] != nil {
            return WriteResult(ok: true, message: "Démonstration : rien n'a changé")
        }
        return WriteResult(ok: true)
    }
}
