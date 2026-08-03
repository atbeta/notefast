import SwiftUI
import WebKit

/// 内容区：WKWebView 全窗口加载内嵌 server 的 Web UI。
/// 加载完全由 `navigator` 驱动（启动初始加载 / 菜单 / 深链 / 工具栏），
/// 组件自身不带 url prop——避免「导航桥与 prop 双源竞争」导致的弹回首页。
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
        coordinator.onTitleChange = onTitleChange
        if let navigator {
            navigator.attach(
                load: { [weak webView] url in
                    webView?.load(URLRequest(url: url))
                },
                reload: { [weak webView] in
                    webView?.reload()
                },
                evaluate: { [weak webView] script in
                    webView?.evaluateJavaScript(script, completionHandler: nil)
                }
            )
        }
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        // 无 url prop：导航一律走 navigator，这里不做任何加载
        context.coordinator.onTitleChange = onTitleChange
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var onTitleChange: ((String) -> Void)?

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.evaluateJavaScript("document.title") { result, _ in
                guard let title = result as? String, !title.isEmpty else { return }
                self.onTitleChange?(title)
            }
        }
    }
}
