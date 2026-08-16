import SwiftUI
import NoteFast

/// 主界面：WKWebView 全窗口加载完整 Web 应用（web 自带侧栏/标签/图谱等全部导航）。
/// 窗口为隐藏式标题栏（`.windowStyle(.hiddenTitleBar)`）：红绿灯悬浮在 web 侧栏净空上，
/// 标题栏区域由 web 绘制。壳层只保留菜单命令 + 标题栏双击缩放（见 attachWindowChrome）。
struct MainView: View {
    @ObservedObject var model: AppModel
    let handshake: EngineHandshake

    var body: some View {
        DocWebView(
            navigator: model.navigator,
            onTitleChange: { title in
                guard !model.versionIncompatible else { return }
                model.windowTitle = title.isEmpty ? "NoteFast" : title
            },
            onThemeChange: { dark in
                model.applyWebTheme(dark: dark)
            },
            onWebReady: {
                model.webReadyForPreview()
            }
        )
        .background(WindowAccessor { window in
            model.attachWindowChrome(to: window)
        })
    }
}
