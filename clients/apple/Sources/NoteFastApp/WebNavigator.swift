import Foundation

/// 壳层 → WebView 的导航桥（唯一加载通道）。
/// 菜单（⌘N 新建）、深链（notefast://）、启动初始加载都经它驱动内容区，
/// WebView 内部导航（点链接）不受壳层干扰。
@MainActor
final class WebNavigator {
    private var loadHandler: ((URL) -> Void)?
    private var reloadHandler: (() -> Void)?
    private var evaluateHandler: ((String) -> Void)?
    /// attach 前发起的导航（如启动握手刚完成、WebView 尚未挂载）：挂载后立即补发
    private var pendingURL: URL?

    /// DocWebView 挂载时注册（每次挂载覆盖，单一内容区）
    func attach(
        load: @escaping (URL) -> Void,
        reload: @escaping () -> Void,
        evaluate: @escaping (String) -> Void
    ) {
        loadHandler = load
        reloadHandler = reload
        evaluateHandler = evaluate
        if let url = pendingURL {
            pendingURL = nil
            load(url)
        }
    }

    func navigate(to url: URL) {
        pendingURL = url
        loadHandler?(url)
    }

    func reload() {
        reloadHandler?()
    }

    /// 在页面上下文执行 JS（壳层兜底：菜单拦截被输入系统吞掉的快捷键后派发合成事件）
    func evaluate(_ script: String) {
        evaluateHandler?(script)
    }
}
