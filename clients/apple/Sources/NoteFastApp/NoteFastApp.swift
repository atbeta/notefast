import SwiftUI
import AppKit

@main
struct NoteFastApp: App {
    @StateObject private var model = AppModel()
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
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

/// 单窗口应用：关闭最后一个窗口即退出（engine 随退出优雅停机，drain 已提速）
final class AppDelegate: NSObject, NSApplicationDelegate {
    /// App 结构体注入（ContentView.onAppear）：文件打开事件转发给 AppModel 做「打开即导入」
    weak var model: AppModel?

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
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
