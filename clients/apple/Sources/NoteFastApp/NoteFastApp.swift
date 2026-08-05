import SwiftUI
import AppKit

@main
struct NoteFastApp: App {
    @StateObject private var model = AppModel()
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
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
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}
