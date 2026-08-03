import Foundation

/// 壳层 → WebView 的导航桥。
/// 菜单（⌘N 新建）、深链（notefast://）、工具栏动作都通过它驱动内容区，
/// 避免把 URL 状态塞进 SwiftUI 状态机（WebView 内部导航不应被重置）。
@MainActor
final class WebNavigator {
    private var loadHandler: ((URL) -> Void)?
    private var reloadHandler: (() -> Void)?

    /// DocWebView 挂载时注册（每次挂载都会覆盖，单一内容区）
    func attach(load: @escaping (URL) -> Void, reload: @escaping () -> Void) {
        loadHandler = load
        reloadHandler = reload
    }

    func navigate(to url: URL) {
        loadHandler?(url)
    }

    func reload() {
        reloadHandler?()
    }
}
