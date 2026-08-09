import SwiftUI
import WebKit

/// 内容区：WKWebView 全窗口加载内嵌 server 的 Web UI。
/// 加载完全由 `navigator` 驱动（启动初始加载 / 菜单 / 深链 / 工具栏），
/// 组件自身不带 url prop——避免「导航桥与 prop 双源竞争」导致的弹回首页。
///
/// 导航策略（Coordinator）：
/// - 内嵌 server 同源（127.0.0.1 / localhost）：放行；target=_blank 的同源链接在当前页打开（壳内无多标签）
/// - 外部链接（http/https/mailto…）：交 `NSWorkspace` 系统默认应用，不在 WebView 内跳走（无返回手段）
/// - 下载（<a download> / blob 导出 / 不可展示 MIME）：转 WKDownload 存 ~/Downloads，重名自动加序号
struct DocWebView: NSViewRepresentable {
    var navigator: WebNavigator?
    var onTitleChange: ((String) -> Void)?

    func makeNSView(context: Context) -> WKWebView {
        let coordinator = context.coordinator
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = coordinator
        webView.allowsMagnification = true
        webView.allowsBackForwardNavigationGestures = true
        coordinator.onTitleChange = onTitleChange
        navigator?.attach(webView: webView)
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        // 无 url prop：导航一律走 navigator，这里不做任何加载
        context.coordinator.onTitleChange = onTitleChange
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKNavigationDelegate, WKDownloadDelegate {
        var onTitleChange: ((String) -> Void)?

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.evaluateJavaScript("document.title") { result, _ in
                guard let title = result as? String, !title.isEmpty else { return }
                self.onTitleChange?(title)
            }
        }

        // MARK: 导航策略

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            // <a download> / blob 导出（Markdown 导出、备份下载）走下载通道
            if navigationAction.shouldPerformDownload { return .download }
            guard let url = navigationAction.request.url,
                  let scheme = url.scheme?.lowercased() else { return .allow }
            // about:blank / srcdoc 等框架内部导航放行
            if scheme == "about" { return .allow }
            if Self.isInternal(url) {
                if navigationAction.targetFrame == nil {
                    webView.load(URLRequest(url: url))
                    return .cancel
                }
                return .allow
            }
            if ["http", "https", "mailto"].contains(scheme) {
                NSWorkspace.shared.open(url)
            }
            // 其余外部 scheme（tel: 等）一律不交给 WebView
            return .cancel
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse
        ) async -> WKNavigationResponsePolicy {
            navigationResponse.canShowMIMEType ? .allow : .download
        }

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
            download.delegate = self
        }

        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
            download.delegate = self
        }

        // MARK: WKDownloadDelegate

        func download(
            _ download: WKDownload,
            decideDestinationUsing response: URLResponse,
            suggestedFilename: String
        ) async -> URL? {
            let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
                ?? FileManager.default.temporaryDirectory
            let ext = (suggestedFilename as NSString).pathExtension
            let base = (suggestedFilename as NSString).deletingPathExtension
            var candidate = dir.appendingPathComponent(suggestedFilename)
            var n = 2
            while FileManager.default.fileExists(atPath: candidate.path) {
                let name = ext.isEmpty ? "\(base)-\(n)" : "\(base)-\(n).\(ext)"
                candidate = dir.appendingPathComponent(name)
                n += 1
            }
            return candidate
        }

        private static func isInternal(_ url: URL) -> Bool {
            guard let host = url.host?.lowercased() else { return false }
            return host == "127.0.0.1" || host == "localhost" || host == "::1"
        }
    }
}
