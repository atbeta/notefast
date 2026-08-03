import SwiftUI
import WebKit

/// 内容区：WKWebView 加载内嵌 server 的 Web UI（`/?native=macos`）。
/// - `url` 变化 → 导航（侧栏选中文档）
/// - `navigator` 提供壳层命令通道（菜单/深链/工具栏）
/// - 页面加载完成回传 `<title>`（驱动窗口标题）
struct DocWebView: NSViewRepresentable {
    var url: URL
    var navigator: WebNavigator?
    var onTitleChange: ((String) -> Void)?

    func makeNSView(context: Context) -> WKWebView {
        let coordinator = context.coordinator
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = coordinator
        webView.allowsMagnification = true
        coordinator.onTitleChange = onTitleChange
        if let navigator {
            navigator.attach(
                load: { [weak webView, weak coordinator] url in
                    coordinator?.lastLoadedURL = url
                    webView?.load(URLRequest(url: url))
                },
                reload: { [weak webView, weak coordinator] in
                    if let current = webView?.url {
                        coordinator?.lastLoadedURL = current
                    }
                    webView?.reload()
                }
            )
        }
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.lastLoadedURL != url else { return }
        context.coordinator.lastLoadedURL = url
        webView.load(URLRequest(url: url))
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKNavigationDelegate {
        /// 最近一次主动加载的 URL：WebView 内部导航（点链接）不被 updateNSView 重置
        var lastLoadedURL: URL?
        var onTitleChange: ((String) -> Void)?

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.evaluateJavaScript("document.title") { result, _ in
                guard let title = result as? String, !title.isEmpty else { return }
                self.onTitleChange?(title)
            }
        }
    }
}
