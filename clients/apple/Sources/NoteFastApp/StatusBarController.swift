import AppKit

/// 菜单栏常驻图标（NSStatusItem）。
/// 与「关窗不退出」配套：主窗口关闭后 app 仍常驻菜单栏，从这里一键回访/新建/收集箱。
/// 图标用 SF Symbol 模板渲染（isTemplate），自动适配菜单栏深浅色与选中态。
@MainActor
final class StatusBarController: NSObject {
    private weak var model: AppModel?
    private let statusItem: NSStatusItem

    init(model: AppModel?) {
        self.model = model
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()

        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "note.text", accessibilityDescription: "NoteFast")
            button.image?.isTemplate = true
        }

        let menu = NSMenu()
        menu.addItem(makeItem("显示主窗口", action: #selector(showMainWindow)))
        menu.addItem(makeItem("新建笔记", action: #selector(newDoc)))
        menu.addItem(makeItem("打开收集箱", action: #selector(openInbox)))
        menu.addItem(.separator())
        menu.addItem(makeItem("退出 NoteFast", action: #selector(quit)))
        statusItem.menu = menu
    }

    private func makeItem(_ title: String, action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        return item
    }

    @objc private func showMainWindow() {
        model?.showMainWindow()
    }

    @objc private func newDoc() {
        model?.newDoc()
    }

    @objc private func openInbox() {
        model?.openInbox()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}
