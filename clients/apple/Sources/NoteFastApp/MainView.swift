import SwiftUI
import NoteFast

/// 主界面：WKWebView 全窗口加载完整 Web 应用（web 自带侧栏/标签/图谱等全部导航）。
/// 原生壳只提供 chrome：菜单、同步面板、新建/设置入口、深链。
/// 注意：内容区不能用 ignoresSafeArea——内容延伸到标题栏下会在最大化（绿点缩放）时
/// 让标题栏/工具栏区域渲染成黑条；标题栏只放应用图标，不重复 web 内的 NoteFast 品牌。
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
        .navigationTitle("")
        .toolbar {
            // 不放置 principal 项——居中图标会渲染成带边框的按钮样，观感差；
            // 标题栏保持干净（仅红绿灯），功能入口放右侧标准工具栏按钮
            ToolbarItemGroup(placement: .primaryAction) {
                SyncStatusButton(model: model)
                Button {
                    model.newDoc()
                } label: {
                    Label("新建笔记", systemImage: "square.and.pencil")
                }
                .help("新建笔记 (⌘N)")
                Button {
                    model.openSettings()
                } label: {
                    Label("设置", systemImage: "gearshape")
                }
                .help("设置")
            }
        }
    }
}
