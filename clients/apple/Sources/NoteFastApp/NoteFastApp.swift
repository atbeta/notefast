import SwiftUI
import AppKit

@main
struct NoteFastApp: App {
    @StateObject private var model = AppModel()
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup(id: "main") {
            ContentView(model: model)
                .onAppear { appDelegate.model = model }
                .onOpenURL { url in
                    model.handle(url: url)
                }
        }
        .defaultSize(width: 1100, height: 720)
        // 隐藏式标题栏：web 内容延伸至窗口顶缘，红绿灯悬浮在侧栏净空区上
        .windowStyle(.hiddenTitleBar)
        .commands {
            AppMenuCommands(model: model)
        }
    }
}

/// 关窗不退出（菜单栏图标常驻，见 StatusBarController；两者是一套决策）：
/// 关窗后 app 驻留菜单栏/Dock，点 Dock、菜单栏项、深链、文件导入都会重建主窗口。
/// 退出走 ⌘Q / 菜单栏「退出」→ willTerminate → engine SIGTERM drain。
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    /// App 结构体注入（ContentView.onAppear）：文件打开事件转发给 AppModel 做「打开即导入」
    weak var model: AppModel? {
        didSet {
            if statusBar == nil {
                statusBar = StatusBarController(model: model)
            }
        }
    }
    /// 菜单栏常驻图标（强引用在 AppDelegate，生命周期 = app 生命周期）
    private var statusBar: StatusBarController?

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    /// 点 Dock 图标且无可见窗口：重建主窗口（SwiftUI WindowGroup 默认不会自己重建）。
    /// 已自行 openWindow 时必须 return false——return true 会让 AppKit 再开一扇空窗
    /// （表现为「两个空白窗口」）。
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if flag { return true }
        model?.showMainWindow()
        return false
    }

    /// 双击 .md / 拖到 Dock 图标（Info.plist 的 CFBundleDocumentTypes 注册后由 LaunchServices 派发；
    /// 注意 SwiftUI 形态下实际多走 onOpenURL 的 file:// 分支，这里只是兜底）
    func application(_ sender: NSApplication, openFile filename: String) -> Bool {
        model?.importMarkdownFile(at: URL(fileURLWithPath: filename))
        return true
    }

    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        for f in filenames {
            model?.importMarkdownFile(at: URL(fileURLWithPath: f))
        }
    }
}
