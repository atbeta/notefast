import Foundation

/// 语义化版本比较（客户端 pin 最低 engine 版本用）。
/// 规则：`major.minor.patch` 三段数值比较；支持 `v` 前缀与 `-pre` 后缀（后缀仅影响相等判定）。
public enum SemVer {
    /// a < b → -1；a == b → 0；a > b → 1
    public static func compare(_ a: String, _ b: String) -> Int {
        let (ma, mb) = (parse(a), parse(b))
        for i in 0..<3 {
            if ma[i] != mb[i] { return ma[i] < mb[i] ? -1 : 1 }
        }
        return 0
    }

    /// version >= min
    public static func isAtLeast(_ version: String, min: String) -> Bool {
        compare(version, min) >= 0
    }

    private static func parse(_ raw: String) -> [Int] {
        let s = raw.trimmingCharacters(in: .whitespaces).lowercased()
            .replacingOccurrences(of: "^v", with: "", options: .regularExpression)
        // 忽略 -pre / +meta 后缀
        let core = s.split(whereSeparator: { $0 == "-" || $0 == "+" }).first.map(String.init) ?? s
        let parts = core.split(separator: ".").map { Int($0) ?? 0 }
        return (0..<3).map { i in i < parts.count ? parts[i] : 0 }
    }
}
