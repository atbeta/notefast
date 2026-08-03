import SwiftUI
import NoteFast

/// 主界面：WKWebView 全窗口加载完整 Web 应用（web 自带侧栏/标签/图谱等全部导航）。
/// 原生壳只提供 chrome：菜单、同步面板、新建/设置入口、窗口标题、深链。
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
        .ignoresSafeArea()
        .navigationTitle(model.windowTitle)
        .toolbar {
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
