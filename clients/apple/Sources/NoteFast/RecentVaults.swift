import Foundation

/// 最近打开的 vault 条目（壳侧记忆）。
///
/// 只存路径：索引位置（DATA_DIR）由引擎按 `sha256(vault 路径)` 派生，壳不复制这条规则
/// （RFC 0001 D4 的口径留在 `packages/server/src/native/bootstrap.ts`）。
public struct VaultEntry: Codable, Equatable, Identifiable {
    public let path: String

    public var id: String { path }

    public init(path: String) {
        self.path = path
    }

    /// 菜单显示名：文件夹名（根目录等取不到名字时退回整条路径）
    public var name: String {
        let trimmed = path.hasSuffix("/") ? String(path.dropLast()) : path
        let base = (trimmed as NSString).lastPathComponent
        return base.isEmpty ? path : base
    }

    public var url: URL { URL(fileURLWithPath: path) }
}

/// 「最近 vault」列表：UserDefaults 里存一个路径数组，最新在前、去重、封顶 10 条。
///
/// 为什么放壳侧而不是引擎：这是**本机 UI 足迹**（与「最近访问」同类），
/// 换 vault 后仍要能看见上一条；引擎只认 `VAULT_PATH`，不持久化历史。
public final class RecentVaults {
    /// 上限：菜单只展示前几条，存太多没意义
    public static let maxEntries = 10
    /// UserDefaults 键（与 web 侧 localStorage 无关，纯壳层）
    public static let defaultKey = "notefast.recentVaults"

    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = RecentVaults.defaultKey) {
        self.defaults = defaults
        self.key = key
    }

    /// 当前列表（最新在前）
    public func all() -> [VaultEntry] {
        Self.normalized(defaults.stringArray(forKey: key) ?? []).map(VaultEntry.init(path:))
    }

    /// 记一次打开：置顶 + 去重 + 截断，返回新列表
    @discardableResult
    public func remember(_ path: String) -> [VaultEntry] {
        let next = Self.normalized([Self.normalize(path)] + all().map(\.path))
        defaults.set(next, forKey: key)
        return next.map(VaultEntry.init(path:))
    }

    /// 从列表移除（文件夹被删 / 用户主动清理）
    @discardableResult
    public func remove(_ path: String) -> [VaultEntry] {
        let target = Self.comparisonKey(path)
        let next = all().filter { Self.comparisonKey($0.path) != target }
        defaults.set(next.map(\.path), forKey: key)
        return next
    }

    public func clear() {
        defaults.removeObject(forKey: key)
    }

    /// 路径规范化：去尾斜杠、折叠 `..`（不存在也不报错）
    public static func normalize(_ path: String) -> String {
        let url = URL(fileURLWithPath: path).standardizedFileURL
        var p = url.path
        while p.count > 1 && p.hasSuffix("/") { p.removeLast() }
        return p
    }

    /// 去重键：macOS / Windows 卷默认大小写不敏感，同一文件夹不应出现两次
    public static func comparisonKey(_ path: String) -> String {
        normalize(path).lowercased()
    }

    /// 纯函数：去重（保留首次出现，即最新的写法）+ 截断
    public static func normalized(_ paths: [String], keeping limit: Int = maxEntries) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for raw in paths where !raw.isEmpty {
            let normalized = normalize(raw)
            guard seen.insert(comparisonKey(normalized)).inserted else { continue }
            out.append(normalized)
            if out.count >= limit { break }
        }
        return out
    }
}
