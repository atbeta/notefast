import SwiftUI

/// 壳层菜单栏。⌘K / ⌘J 等由菜单拦截后向页面派发合成事件（输入法会吞掉直达页面的按键）；
/// ⌘N 覆盖 WindowGroup 默认的「新建窗口」；导航/缩放/打印走 WebNavigator 直接操作 WKWebView。
struct AppMenuCommands: Commands {
    @ObservedObject var model: AppModel

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("新建笔记") {
                model.newDoc()
            }
            .keyboardShortcut("n")
        }

        // ⌘,：macOS 标准设置入口（跳转 web 设置页）
        CommandGroup(replacing: .appSettings) {
            Button("设置…") {
                model.openSettings()
            }
            .keyboardShortcut(",")
        }

        // ⌘P 给编辑器「预览/编辑」；打印改走 ⌘⇧P，避免菜单先把按键吃掉
        CommandGroup(replacing: .printItem) {
            Button("打印…") {
                model.navigator.printPage()
            }
            .keyboardShortcut("p", modifiers: [.command, .shift])
            .disabled(!model.isRunning)
        }

        CommandGroup(after: .textEditing) {
            Button("查找…") {
                model.openFind()
            }
            .keyboardShortcut("f")
            .disabled(!model.isRunning)
            Button("查找下一个") {
                model.findNext()
            }
            .keyboardShortcut("g")
            .disabled(!model.isRunning)
            Button("查找上一个") {
                model.findPrev()
            }
            .keyboardShortcut("g", modifiers: [.command, .shift])
            .disabled(!model.isRunning)
        }

        CommandMenu("视图") {
            Button("后退") {
                model.navigator.goBack()
            }
            .keyboardShortcut("[")
            Button("前进") {
                model.navigator.goForward()
            }
            .keyboardShortcut("]")
            Divider()
            Button("放大") {
                model.navigator.zoomIn()
            }
            .keyboardShortcut("+")
            Button("缩小") {
                model.navigator.zoomOut()
            }
            .keyboardShortcut("-")
            Button("实际大小") {
                model.navigator.zoomReset()
            }
            .keyboardShortcut("0")
            Divider()
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
            Button("关于 NoteFast") {
                model.openAbout()
            }
            Button("检查更新…") {
                model.checkForUpdates(userInitiated: true)
            }
            if let update = model.availableUpdate {
                Button("下载新版 v\(update.version)") {
                    model.openUpdateDownload()
                }
            }
            Divider()
            Button("复制本机 MCP 地址") {
                model.copyMCPAddress()
            }
            .disabled(!model.isRunning)
            Button("显示 engine 日志") {
                model.revealEngineLog()
            }
            Button("显示数据目录") {
                model.revealDataDir()
            }
            if let message = model.syncActionMessage {
                Divider()
                Text(message)
            }
        }
    }
}
