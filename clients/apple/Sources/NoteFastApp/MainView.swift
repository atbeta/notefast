import SwiftUI
import NoteFast

/// 主界面：WKWebView 全窗口加载完整 Web 应用（web 自带侧栏/标签/图谱等全部导航）。
/// 窗口为隐藏式标题栏（`.windowStyle(.hiddenTitleBar)`）：红绿灯直接悬浮在 web 侧栏
/// 顶部，标题栏区域由 web 内容绘制——观感随 web 主题切换，不再有原生大色条。
/// 侧栏 brand 行已预留红绿灯净空并兼作窗口拖拽区（data-drag-region，见 web Sidebar）。
/// 壳层只保留菜单栏命令（新建/命令面板/刷新/MCP 地址）；同步状态与手动同步由
/// web 端 GlobalSyncStatus 胶囊与设置页多端同步面板呈现，不再重复造原生工具栏。
struct MainView: View {
    @ObservedObject var model: AppModel
    let handshake: EngineHandshake

    var body: some View {
        DocWebView(
            navigator: model.navigator,
            onTitleChange: { title in
                guard !model.versionIncompatible else { return }
                model.windowTitle = title.isEmpty ? "NoteFast" : title
            }
        )
    }
}
