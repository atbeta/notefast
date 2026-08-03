import Foundation

/// 文档摘要（对齐 `GET /docs/list` 返回的 `DocSummary[]`，见 server `api/docs.ts`）。
/// 字段语义与 `@notefast/core` 一致；条件字段（ai_exclude / status）缺省为 nil。
public struct DocSummary: Decodable, Identifiable, Equatable {
    public let id: String
    public let title: String
    public let createdAt: String
    public let updatedAt: String
    public let tags: [String]
    public let aiExclude: Bool?
    public let status: String?

    enum CodingKeys: String, CodingKey {
        case id, title, tags
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case aiExclude = "ai_exclude"
        case status
    }
}

/// 实例版本（对齐 `GET /api/v1/version`）。
public struct ServerVersion: Decodable, Equatable {
    public let version: String
}
