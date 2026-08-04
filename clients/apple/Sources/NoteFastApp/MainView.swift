import SwiftUI
import AppKit
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
            // 标题栏居中只放应用图标（文档标题在 web 内容区已有，避免重复）
            ToolbarItem(placement: .principal) {
                Image(nsImage: NSApp.applicationIconImage)
                    .resizable()
                    .frame(width: 18, height: 18)
            }
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
