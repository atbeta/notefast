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

/// 多端同步状态（对齐 `GET /api/v1/sync/protocol`，见 server `sync/protocolManager.ts`）。
public struct SyncProtocolStatus: Decodable, Equatable {
    public let configured: Bool
    public let enabled: Bool
    public let s3Bucket: String?
    public let s3Prefix: String?
    public let lastRunAt: String?
    public let lastSuccessAt: String?
    public let lastError: String?
    public let state: SyncState?
    public let pendingChanges: Int?
    public let running: Bool?

    public struct SyncState: Decodable, Equatable {
        public let publishedSeq: Int
        public let consumedSeq: Int
        public let sinceSnapshot: Int
    }
}

/// `POST /sync/protocol/run` 结果。
public struct SyncRunResult: Decodable, Equatable {
    public let ok: Bool
    public let published: Int?
    public let snapshotCreated: Bool?
    public let state: SyncProtocolStatus.SyncState?
    public let status: SyncProtocolStatus?
}

/// `POST /sync/protocol/pull` 结果（消费端拉取：首次全量 / 增量合并 + media）。
public struct SyncPullResult: Decodable, Equatable {
    public let ok: Bool
    public let mode: String?
    public let applied: Int?
    public let mediaRestored: Int?
    public let state: SyncProtocolStatus.SyncState?
    public let status: SyncProtocolStatus?
}

/// `POST /import/markdown` 结果（壳层只取 doc.id 用于导入后跳转）。
public struct ImportMarkdownResult: Decodable, Equatable {
    public let doc: DocRef

    public struct DocRef: Decodable, Equatable {
        public let id: String
    }
}
