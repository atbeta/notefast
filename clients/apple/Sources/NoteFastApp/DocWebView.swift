import SwiftUI
import WebKit

/// 内容区：WKWebView 加载内嵌 server 的 Web UI（`/?native=macos`）。
/// 侧栏切换文档时 updateNSView 导航到 `/doc/<id>?native=macos`。
struct DocWebView: NSViewRepresentable {
    var url: URL

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.allowsMagnification = true
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.lastLoadedURL != url else { return }
        context.coordinator.lastLoadedURL = url
        webView.load(URLRequest(url: url))
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKNavigationDelegate {
        /// 记录最近一次主动加载的 URL：避免 WebView 内部导航（点链接）被 updateNSView 重置
        var lastLoadedURL: URL?
    }
}
