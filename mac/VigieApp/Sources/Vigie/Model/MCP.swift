import Foundation

/// GET /api/v2/mcp
struct MCPState: Decodable, Equatable, Sendable {
    @Lossy var user: [UserMCP]
    @Lossy var projects: [ProjectMCP]
    @Lossy var local: [ProjectMCP]
    @Lossy var connectors: [Connector]
    var connectorsDefault: String?
}

/// Configuration d'un MCP telle que renvoyée par le moteur (valeurs secrètes masquées « •••• »).
struct MCPConfig: Decodable, Equatable, Sendable {
    var type: String?
    var command: String?
    @Lossy var args: [String]
    var url: String?
    var env: [String: String]?
    var headers: [String: String]?
}

struct UserMCP: Decodable, Equatable, Sendable, Identifiable {
    var name: String
    var type: String?
    var target: String?
    var service: String?
    @Lossy var accounts: [String]
    var uses7d: Int?
    var needsAuth: Bool?
    @Tolerant var config: MCPConfig?
    /// La déclaration n'est pas la même dans tous les comptes.
    var differs: Bool?
    /// Projets où ce MCP est coupé.
    @Lossy var disabledIn: [String]
    /// État réel par compte (claude mcp list).
    @Lossy var health: [MCPHealth]

    var id: String { name }
}

struct ProjectMCP: Decodable, Equatable, Sendable, Identifiable {
    var path: String
    var name: String?
    var file: String?
    @Lossy var servers: [ProjectServer]

    var id: String { path }
    var displayName: String { ProjectName.display(name ?? (path as NSString).lastPathComponent, cwd: path) }
}

struct ProjectServer: Decodable, Equatable, Sendable, Identifiable {
    var name: String
    var type: String?
    var target: String?
    var service: String?
    var uses7d: Int?
    var disabled: Bool?
    @Tolerant var config: MCPConfig?
    @Lossy var accounts: [String]
    @Lossy var health: [MCPHealth]

    var id: String { name }
}

struct Connector: Decodable, Equatable, Sendable, Identifiable {
    var name: String
    var accountId: String?
    var service: String?
    var uses7d: Int?
    @Lossy var health: [MCPHealth]

    var id: String { "\(name)|\(accountId ?? "")" }
}

enum MCPStatus: String, Sendable {
    case connected
    case needsAuth = "needs-auth"
    case failed
    case pendingApproval = "pending-approval"
    case disabled
    case unknown

    init(raw: String?) { self = raw.flatMap(MCPStatus.init(rawValue:)) ?? .unknown }
}

/// État d'un MCP dans un compte, au dernier contrôle.
struct MCPHealth: Decodable, Equatable, Sendable {
    var accountId: String?
    var status: String?
    @FlexDate var checkedAt: Date?
    var message: String?

    var mcpStatus: MCPStatus { MCPStatus(raw: status) }
}
