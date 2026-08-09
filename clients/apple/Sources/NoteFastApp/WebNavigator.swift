import Foundation
import WebKit

/// 壳层 → WebView 的导航桥（唯一加载通道）。
/// 菜单（⌘N 新建 / ⌘[ ⌘] 后退前进 / 缩放 / 打印）、深链（notefast://）、启动初始加载
/// 都经它驱动内容区，WebView 内部导航（点链接）不受壳层干扰。
@MainActor
final class WebNavigator {
    /// DocWebView 挂载时注册（weak：壳层不持有 WebView，其生命周期归 SwiftUI）
    private weak var webView: WKWebView?
    /// attach 前发起的导航（如启动握手刚完成、WebView 尚未挂载）：挂载后立即补发；
    /// 之后记录最近一次导航目标，WebView 重建时可回放
    private var pendingURL: URL?

    /// DocWebView 挂载时注册（每次挂载覆盖，单一内容区）
    func attach(webView: WKWebView) {
        self.webView = webView
        if let url = pendingURL {
            pendingURL = nil
            webView.load(URLRequest(url: url))
        }
    }

    func navigate(to url: URL) {
        pendingURL = url
        webView?.load(URLRequest(url: url))
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

    // MARK: - 打印（⌘P）

    func printPage() {
        webView?.printOperation(with: .shared).run()
    }

    /// 在页面上下文执行 JS（壳层兜底：菜单拦截被输入系统吞掉的快捷键后派发合成事件）
    func evaluate(_ script: String) {
        webView?.evaluateJavaScript(script, completionHandler: nil)
    }
}
