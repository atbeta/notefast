import SwiftUI
import NoteFast

/// 主界面：侧栏文档列表（原生 SwiftUI）+ 内容区（WKWebView 加载内嵌 server）。
struct MainView: View {
    @ObservedObject var model: AppModel
    let handshake: EngineHandshake

    var body: some View {
        NavigationSplitView {
            DocListSidebar(model: model)
                .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 360)
        } detail: {
            DocWebView(
                url: detailURL,
                navigator: model.navigator,
                onTitleChange: { title in
                    guard !model.versionIncompatible else { return }
                    model.windowTitle = title.isEmpty ? "NoteFast" : title
                }
            )
            .ignoresSafeArea()
        }
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

    private var detailURL: URL {
        if let id = model.selectedDocID, let url = model.docURL(id) {
            return url
        }
        return model.entryURL ?? URL(string: "http://127.0.0.1")!
    }
}
