import Foundation
import WebKit

/// 壳层 → WebView 的导航桥（唯一加载通道）。
/// 菜单（⌘N 新建 / ⌘[ ⌘] 后退前进 / 缩放 / 打印）、深链（notefast://）、启动初始加载
/// 都经它驱动内容区，WebView 内部导航（点链接）不受壳层干扰。
@MainActor
final class WebNavigator {
    /// DocWebView 挂载时注册（weak：壳层不持有 WebView，其生命周期归 SwiftUI）
    private weak var webView: WKWebView?
    /// attach 前发起的导航（如启动握手刚完成、WebView 尚未挂载）：挂载后立即补发
    private var pendingURL: URL?
    /// 最近一次导航目标：关窗后 WKWebView 销毁，重开挂载时回放（pending 可能已清空）
    private var lastURL: URL?

    /// DocWebView 挂载时注册（每次挂载覆盖，单一内容区）
    func attach(webView: WKWebView) {
        self.webView = webView
        // 优先 pending（刚 navigate 还未 attach）；否则回放 lastURL（窗口重建）
        if let url = pendingURL ?? lastURL {
            pendingURL = nil
            webView.load(URLRequest(url: url))
        }
    }

    func navigate(to url: URL) {
        lastURL = url
        pendingURL = url
        guard let webView else { return }

        // 已在同源 SPA：走客户端路由，避免整页重载（双击打开的热路径）
        if Self.canUseSpaNavigation(from: webView.url, to: url) {
            let path = Self.pathAndQuery(of: url)
            let script = """
            (function(){
              try {
                if (typeof window.__notefastNavigate === 'function') {
                  window.__notefastNavigate(\(Self.jsString(path)));
                  return 'spa';
                }
              } catch (e) {}
              return 'missing';
            })()
            """
            pendingURL = nil
            webView.evaluateJavaScript(script) { [weak webView] result, _ in
                guard (result as? String) != "spa" else { return }
                DispatchQueue.main.async {
                    webView?.load(URLRequest(url: url))
                }
            }
            return
        }

        webView.load(URLRequest(url: url))
    }

    /// 当前页已是 engine 同源（非 about:blank / 启动占位）时才能走 SPA
    private static func canUseSpaNavigation(from current: URL?, to target: URL) -> Bool {
        guard let current, let ch = current.host, let th = target.host else { return false }
        guard current.scheme == target.scheme, ch == th else { return false }
        if current.port != target.port { return false }
        if current.path == "about:blank" || current.absoluteString == "about:blank" { return false }
        return true
    }

    private static func pathAndQuery(of url: URL) -> String {
        guard let query = url.query, !query.isEmpty else { return url.path }
        return "\(url.path)?\(query)"
    }

    /// JSON 字符串字面量，供拼进 evaluateJavaScript
    /// （JSONSerialization 顶层只接受数组/字典，包一层再剥掉）
    private static func jsString(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              let wrapped = String(data: data, encoding: .utf8),
              wrapped.first == "[", wrapped.last == "]"
        else { return "\"\"" }
        return String(wrapped.dropFirst().dropLast())
    }

    func reload() {
        webView?.reload()
    }

    // MARK: - 历史导航（⌘[ / ⌘]，WKWebView 内部无历史时为 no-op）

    func goBack() { webView?.goBack() }
    func goForward() { webView?.goForward() }

    // MARK: - 缩放（⌘+ / ⌘- / ⌘0），步进 ~1.2x

    private static let minZoom = 0.5
    private static let maxZoom = 3.0

    func zoomIn() { setZoom((webView?.pageZoom ?? 1) * 1.2) }
    func zoomOut() { setZoom((webView?.pageZoom ?? 1) / 1.2) }
    func zoomReset() { setZoom(1) }

    private func setZoom(_ zoom: Double) {
        webView?.pageZoom = min(Self.maxZoom, max(Self.minZoom, zoom))
    }

    // MARK: - 导出 PDF（菜单 ⌘⇧P；⌘P 留给编辑器预览）

    func printPage() {
        webView?.printOperation(with: .shared).run()
    }

    /// 在页面上下文执行 JS（壳层兜底：菜单拦截被输入系统吞掉的快捷键后派发合成事件）
    func evaluate(_ script: String) {
        webView?.evaluateJavaScript(script, completionHandler: nil)
    }
}
