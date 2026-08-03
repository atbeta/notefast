import Foundation

/// REST 客户端错误（对齐 server 的 `{ error, message }` 响应）。
public struct NotefastAPIError: Error, LocalizedError, Equatable {
    public let status: Int
    public let code: String?
    public let message: String

    public var errorDescription: String? { message }
}

/// NoteFast REST 客户端：薄封装 URLSession，镜像 `/api/v1` 稳定子集。
/// 契约见 AGENTS.md「壳层只消费稳定子集（docs / blocks / search / sync protocol）」。
public final class NoteFastClient {
    private let baseURL: URL
    private let session: URLSession

    /// - Parameter baseURL: 形如 `http://127.0.0.1:<port>/api/v1`
    public init(baseURL: URL, authToken: String? = nil, timeout: TimeInterval = 20) {
        self.baseURL = baseURL
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = timeout
        config.httpAdditionalHeaders = authToken.map { ["Authorization": "Bearer \($0)"] }
        self.session = URLSession(configuration: config)
    }

    public func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        let url = url(for: path)
        let (data, response) = try await session.data(from: url)
        try validate(response, data: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    public func getData(_ path: String) async throws -> Data {
        let url = url(for: path)
        let (data, response) = try await session.data(from: url)
        try validate(response, data: data)
        return data
    }

    private func url(for path: String) -> URL {
        // path 以 `/` 开头（如 `/docs/list`），appendingPathComponent 会正确拼接
        baseURL.appendingPathComponent(path)
    }

    private func validate(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let code = body?["error"] as? String
            let message = (body?["message"] as? String) ?? "HTTP \(http.statusCode)"
            throw NotefastAPIError(status: http.statusCode, code: code, message: message)
        }
    }
}
