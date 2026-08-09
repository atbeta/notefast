import Foundation

/// GitHub Releases 轻量更新检查。
/// 非 Sparkle：只查最新 release 版本号并与当前版比较，有新版提示用户去下载页。
/// 等装机量值得时再升级 Sparkle/appcast 全自动更新。
public struct ReleaseInfo: Equatable, Sendable {
    /// 去掉 v 前缀的语义化版本（tag "v0.55.0" → "0.55.0"）
    public let version: String
    /// release 页面（「前往下载」目标）
    public let url: URL

    public init(version: String, url: URL) {
        self.version = version
        self.url = url
    }
}

public enum UpdateChecker {
    public static let releasesAPI = URL(string: "https://api.github.com/repos/atbeta/notefast/releases/latest")!
    /// 下载页兜底（拿不到 release 列表时也能指路）
    public static let releasesPage = URL(string: "https://github.com/atbeta/notefast/releases/latest")!

    public enum UpdateError: Error, Equatable {
        case http(Int)
        case malformed
    }

    /// 解析 releases/latest 响应。tag_name 允许 v 前缀；缺 tag/html_url 视为无效返回 nil。
    public static func parseLatestRelease(json: Data) -> ReleaseInfo? {
        guard let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
              let tag = obj["tag_name"] as? String,
              let urlString = obj["html_url"] as? String,
              let url = URL(string: urlString) else { return nil }
        let version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
        guard !version.isEmpty else { return nil }
        return ReleaseInfo(version: version, url: url)
    }

    /// current 落后于 latest 即视为有新版（SemVer.isAtLeast 的反向判定）
    public static func isNewer(latest: String, than current: String) -> Bool {
        !SemVer.isAtLeast(current, min: latest)
    }

    public static func fetchLatestRelease() async throws -> ReleaseInfo {
        var request = URLRequest(url: releasesAPI)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 10
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            throw UpdateError.http(http.statusCode)
        }
        guard let info = parseLatestRelease(json: data) else { throw UpdateError.malformed }
        return info
    }
}
