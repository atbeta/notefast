import SwiftUI

/// 壳层菜单栏。⌘K / ⌘J / ⌘\ 等由 Web UI 自身处理（WKWebView 内可达），
/// 壳层只补充原生侧需要的命令；⌘N 覆盖 WindowGroup 默认的「新建窗口」。
struct AppMenuCommands: Commands {
    @ObservedObject var model: AppModel

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("新建笔记") {
                model.newDoc()
            }
            .keyboardShortcut("n")
        }

        CommandMenu("视图") {
            Button("命令面板") {
                model.toggleCommandPalette()
            }
            .keyboardShortcut("k")
            Button("AI 聊天") {
                model.toggleAiChat()
            }
            .keyboardShortcut("j")
            Button("刷新") {
                model.navigator.reload()
            }
            .keyboardShortcut("r")
        }

        CommandMenu("帮助") {
            Button("复制本机 MCP 地址") {
                model.copyMCPAddress()
            }
            .disabled(!model.isRunning)
            if let message = model.syncActionMessage {
                Text(message)
            }
        }
    }
}
