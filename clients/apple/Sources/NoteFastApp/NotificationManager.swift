import AppKit
import UserNotifications

/// macOS 系统通知（UNUserNotificationCenter）。
/// 触发源两个：web 侧经 WKScriptMessageHandler（如同步失败）、壳层自身（engine 崩溃 / 发现新版本）。
/// swift run 直接跑可执行文件时没有 .app bundle，UN 中心不可用——usable 守卫降级为 no-op。
@MainActor
final class NotificationManager: NSObject {
    static let shared = NotificationManager()

    private let usable = Bundle.main.bundleURL.pathExtension == "app"
    private var prepared = false

    func post(title: String, body: String) {
        guard usable else { return }
        prepareIfNeeded()
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        )
    }

    private func prepareIfNeeded() {
        guard !prepared else { return }
        prepared = true
        let center = UNUserNotificationCenter.current()
        center.delegate = NotificationPresenter.shared
        center.requestAuthorization(options: [.alert]) { _, _ in }
    }
}

/// app 前台也显示横幅（同步失败这类事件发生在后台轮询里，用户需要看到）
private final class NotificationPresenter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationPresenter()

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner]
    }
}
