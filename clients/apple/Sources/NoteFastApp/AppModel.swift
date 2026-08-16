import SwiftUI
import AppKit
import CommonCrypto
import NoteFast

/// 应用级状态：内嵌 engine 生命周期 + 同步状态 + 深链/导航命令。
@MainActor
final class AppModel: ObservableObject {
    enum State {
        case starting
        case running(EngineHandshake)
        case failed(Error)
    }

    /// 客户端支持的最低 engine 版本（契约稳定守则：启动握手校验，低于此值提示更新）
    static let minSupportedEngineVersion = "0.31.0"

    @Published private(set) var state: State = .starting
    @Published var windowTitle = "NoteFast"
    @Published var engineVersion: String?
    @Published var versionIncompatible = false
    /// 版本不兼容阻断页的用户豁免（「仍要继续」）
    @Published var dismissedVersionWarning = false
    @Published var syncActionMessage: String?
    /// 有新版可下载（检查更新后非空；帮助菜单出现「下载新版」入口）
    @Published var availableUpdate: ReleaseInfo?

    let navigator = WebNavigator()

    private var engine: EngineProcess?
    private var terminateObserver: NSObjectProtocol?
    private var transientMessageTask: Task<Void, Never>?

    init() {
        // App 退出前优雅停机 engine（SIGTERM drain → 关 DB）。
        // queue: .main 保证回调在主线程同步执行（termination 期间 Task 可能被推迟）；
        // assumeIsolated 让编译器认可「此处确在主 actor」，避免误报并发隔离。
        terminateObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.stop()
            }
        }
    }

    deinit {
        if let observer = terminateObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        transientMessageTask?.cancel()
    }

    var isRunning: Bool {
        if case .running = state { return true }
        return false
    }

    var baseURL: URL? {
        guard case .running(let hs) = state else { return nil }
        return URL(string: "http://127.0.0.1:\(hs.port)/api/v1")
    }

    var entryURL: URL? {
        guard case .running(let hs) = state else { return nil }
        return URL(string: "http://127.0.0.1:\(hs.port)/?native=macos")
    }

    var mcpURL: URL? {
        guard case .running(let hs) = state else { return nil }
        return URL(string: "http://127.0.0.1:\(hs.port)/mcp")
    }

    func docURL(_ id: String) -> URL? {
        guard case .running(let hs) = state else { return nil }
        return URL(string: "http://127.0.0.1:\(hs.port)/doc/\(id)?native=macos")
    }

    func pageURL(_ path: String) -> URL? {
        guard case .running(let hs) = state else { return nil }
        return URL(string: "http://127.0.0.1:\(hs.port)\(path)?native=macos")
    }

    /// 命令面板预填搜索的首页 URL（query 经 URLComponents 正确转义）
    private func paletteSearchURL(_ query: String) -> URL? {
        guard case .running(let hs) = state else { return nil }
        var comps = URLComponents()
        comps.scheme = "http"
        comps.host = "127.0.0.1"
        comps.port = hs.port
        comps.path = "/"
        comps.queryItems = [
            URLQueryItem(name: "native", value: "macos"),
            URLQueryItem(name: "palette_search", value: query),
        ]
        return comps.url
    }

    // MARK: - 生命周期

    func start() async {
        // 窗口重建（关窗不退出后点 Dock/菜单栏重开）会再次触发 .task：
        // engine 还活着就别二次 spawn；但必须把入口 URL 再灌进新挂载的 WKWebView，
        // 否则 DocWebView 是空 about:blank（只防 alreadyRunning、忘了重载 → 空白窗）。
        if engine?.isRunning == true {
            if let url = entryURL {
                navigator.navigate(to: url)
            }
            return
        }
        state = .starting
        let engineDir: URL
        do {
            engineDir = try Self.resolveEngineDir()
        } catch {
            state = .failed(error)
            return
        }
        let engine = EngineProcess(engineDir: engineDir, dataDir: Self.dataDir())
        self.engine = engine
        // 运行期崩溃监控：握手成功后进程意外退出 → 进入失败态（FailureView 可一键重试）+ 系统通知
        engine.onUnexpectedExit = { [weak self] code in
            Task { @MainActor in
                guard let self, self.isRunning else { return }
                self.state = .failed(EngineError.processExited(code))
                NotificationManager.shared.post(
                    title: "NoteFast 已停止运行",
                    body: "本地引擎意外退出（code=\(code)），点击窗口内的「重试」重启。"
                )
            }
        }
        do {
            let hs = try engine.start(timeout: 20)
            state = .running(hs)
            engineVersion = hs.version
            verifyEngineVersion(hs.version)
            navigator.navigate(to: entryURL ?? URL(string: "http://127.0.0.1")!)
            // 待预览文件在 web 侧监听器就绪（webReady）后才 drain，
            // 避免冷启动期 dispatch 的事件被丢——见 enqueuePreviewFile / drainPendingPreviews
        } catch {
            state = .failed(error)
        }
    }

    func restart() {
        stop()
        Task { await start() }
    }

    func stop() {
        engine?.stop(wait: 8)
        engine = nil
    }

    /// 契约稳定守则：engine 版本低于客户端最低支持 → 标记不兼容
    private func verifyEngineVersion(_ version: String) {
        versionIncompatible = !SemVer.isAtLeast(version, min: Self.minSupportedEngineVersion)
        if versionIncompatible {
            windowTitle = "⚠️ 引擎版本过低 (\(version))"
        }
    }

    // MARK: - 轻量更新检查（GitHub Releases；非 Sparkle，只提示跳下载页）

    /// 当前客户端版本 = bundle 版本（组装时写入 engine VERSION），swift run 时回退 engine 握手版本
    var currentVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
            ?? engineVersion ?? "0"
    }

    /// 仅用户主动触发（设置「关于」/ 帮助菜单）；启动不再静默打 GitHub。
    func checkForUpdates(userInitiated: Bool = true) {
        Task { [weak self] in
            guard let self else { return }
            do {
                let latest = try await UpdateChecker.fetchLatestRelease()
                if UpdateChecker.isNewer(latest: latest.version, than: self.currentVersion) {
                    self.availableUpdate = latest
                    NotificationManager.shared.post(
                        title: "NoteFast 有新版本",
                        body: "v\(latest.version) 已发布（当前 v\(self.currentVersion)），可前往下载页获取。"
                    )
                    if userInitiated { self.openUpdateDownload() }
                } else if userInitiated {
                    self.showTransientMessage("已是最新版本 (v\(self.currentVersion))")
                }
            } catch {
                if userInitiated { self.showTransientMessage("检查更新失败，请稍后重试") }
            }
        }
    }

    func openUpdateDownload() {
        NSWorkspace.shared.open(availableUpdate?.url ?? UpdateChecker.releasesPage)
    }

    /// engine 产物目录：优先 bundle 内 Resources/engine（组装期注入）；
    /// dev（swift run）用 `NOTEFAST_ENGINE_DIR` 指向 packages/server/dist-engine。
    private static func resolveEngineDir() throws -> URL {
        if let env = ProcessInfo.processInfo.environment["NOTEFAST_ENGINE_DIR"], !env.isEmpty {
            let url = URL(fileURLWithPath: env)
            if FileManager.default.fileExists(atPath: url.appendingPathComponent("notefast-server").path) {
                return url
            }
        }
        if let resources = Bundle.main.resourceURL {
            let bundled = resources.appendingPathComponent("engine", isDirectory: true)
            if FileManager.default.fileExists(atPath: bundled.appendingPathComponent("notefast-server").path) {
                return bundled
            }
        }
        throw EngineError.binaryNotFound("bundle 与 NOTEFAST_ENGINE_DIR 均未找到内嵌 engine")
    }

    private static func dataDir() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("NoteFast", isDirectory: true)
    }

    // MARK: - 诊断入口（帮助菜单：Finder 中显示 engine 日志 / 数据目录）

    /// engine stderr 日志（启动告警、运行期错误都落这里）
    func revealEngineLog() {
        let url = EngineProcess.logFileURL()
        if FileManager.default.fileExists(atPath: url.path) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } else {
            NSWorkspace.shared.open(url.deletingLastPathComponent())
        }
    }

    func revealDataDir() {
        let dir = Self.dataDir()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(dir)
    }

    // MARK: - 瞬时消息（菜单命令反馈：Help 菜单展示 syncActionMessage）

    private func showTransientMessage(_ message: String) {
        syncActionMessage = message
        transientMessageTask?.cancel()
        transientMessageTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled else { return }
            self?.syncActionMessage = nil
        }
    }

    // MARK: - 打开即预览（.md 文件关联：双击/拖到 Dock → 在 /preview 只读展示，不入库）

    /// engine 启动前或 web 监听器尚未就绪时暂存的待预览文件
    private var pendingPreviewFiles: [URL] = []
    /// web 侧 useFileOpenEvents 监听器就绪标志（收到 {type:'webReady'} 后置位）
    private var webIsReadyForPreview = false

    /// AppDelegate 的 openFile(s) 入口：非 .md 后缀不接收（plist 已过滤，双保险）
    func previewMarkdownFile(at url: URL) {
        let exts: Set<String> = ["md", "markdown", "mdown", "mkd", "txt"]
        guard exts.contains(url.pathExtension.lowercased()) else { return }
        pendingPreviewFiles.append(url)
        drainPendingPreviews()
    }

    /// web 侧 notefast:preview 监听器就绪（DocWebView 转发）→ 排空堆积的待预览文件
    func webReadyForPreview() {
        webIsReadyForPreview = true
        drainPendingPreviews()
    }

    private func drainPendingPreviews() {
        // web 监听器没就绪就等下一轮 webReady；中途新到的文件同样等
        guard webIsReadyForPreview else { return }
        // 关窗不退出后拖到 Dock：WebView 已销毁，事件无处可去——先重建窗口并
        // 导航 /preview，pending 保留，新页面的 webReady 会再次触发本函数真正派发
        guard navigator.isAttached else {
            showMainWindow()
            if let url = pageURL("/preview") { navigator.navigate(to: url) }
            return
        }
        let files = pendingPreviewFiles
        pendingPreviewFiles = []
        guard !files.isEmpty else { return }
        Task { await dispatchPreviewFiles(files) }
    }

    /// 把文件内容逐个通过 CustomEvent 推给 web 的 useFileOpenEvents；
    /// 不在 /preview 时导航过去（整页加载会销毁 JS 上下文，web 端队列
    /// 靠 sessionStorage 跨跳转恢复）；已在 /preview 时事件被活页面直接接收，不跳转
    private func dispatchPreviewFiles(_ files: [URL]) async {
        var dispatched = 0
        for file in files {
            guard let markdown = try? String(contentsOf: file, encoding: .utf8), !markdown.isEmpty else {
                showTransientMessage("无法读取：\(file.lastPathComponent)")
                continue
            }
            let title = file.deletingPathExtension().lastPathComponent
            let path = file.standardizedFileURL.path
            let contentHash = Self.sha256Hex(markdown)
            // JSON 序列化 detail：避免 JS 字符串转义陷阱（content 含换行/引号/反斜杠）
            guard let detailJSON = Self.previewEventJSON(title: title, content: markdown, path: path, contentHash: contentHash) else {
                showTransientMessage("预览失败：\(file.lastPathComponent)")
                continue
            }
            let script = "window.dispatchEvent(new CustomEvent('notefast:preview',{detail:\(detailJSON)}))"
            navigator.evaluate(script)
            dispatched += 1
        }
        guard dispatched > 0 else { return }
        showMainWindow() // 拖到 Dock 触发预览时可能无窗口
        if navigator.currentURL?.path != "/preview", let url = pageURL("/preview") {
            navigator.navigate(to: url)
        }
    }

    /// 预览事件 detail 的 JSON 字面量（注入到 JS 字面量位置，必须是合法 JS 表达式）
    private static func previewEventJSON(title: String, content: String, path: String, contentHash: String) -> String? {
        let detail: [String: Any] = [
            "title": title,
            "content": content,
            "path": path,
            "contentHash": contentHash,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: detail, options: [.fragmentsAllowed]),
              let json = String(data: data, encoding: .utf8) else { return nil }
        return json
    }

    private static func sha256Hex(_ s: String) -> String {
        let bytes = Array(s.utf8)
        // 用 CommonCrypto 算 sha256（CryptoKit 在 Swift 命令行工具链下需要额外 import，
        // 而 CommonCrypto 在 Apple 平台是系统库，免依赖）
        var hash = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        CC_SHA256(bytes, CC_LONG(bytes.count), &hash)
        return hash.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - 深链（notefast://）与文件打开

    func handle(url: URL) {
        // SwiftUI onOpenURL 在 macOS 上同时承接「打开文件」事件（file://）——
        // AppDelegate 的 openFile(s) 未必会触发，这里兜底打开即导入
        if url.isFileURL {
            previewMarkdownFile(at: url)
            return
        }
        guard url.scheme == "notefast", isRunning else { return }
        showMainWindow() // 关窗不退出：深链到来时窗口可能不存在，先确保有窗口再导航
        switch (url.host, url.pathComponents) {
        case ("doc", let parts) where parts.count >= 2:
            if let target = docURL(parts[1]) { navigator.navigate(to: target) }
        case ("new", _):
            if let url = pageURL("/new") { navigator.navigate(to: url) }
        case ("search", _):
            // notefast://search?q=xxx → /?palette_search=xxx（web Layout 消费后打开命令面板并预填）
            let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "q" }?.value
            if let q, !q.isEmpty, let target = paletteSearchURL(q) {
                navigator.navigate(to: target)
            } else if let url = pageURL("/") {
                navigator.navigate(to: url)
            }
        default:
            break
        }
    }

    // MARK: - 窗口管理（关窗不退出：菜单栏 / Dock / 深链重开主窗口）

    /// ContentView.onAppear 注入的 SwiftUI openWindow（Environment 只能视图侧取，壳层借道）
    var openWindowAction: (() -> Void)?

    // MARK: - 窗口铬（标题栏双击缩放；不再挂原生后退/前进条）

    /// 主窗口句柄（weak：关窗即释放）。openWindow(id:) 的复用语义不可靠
    /// （实测会重复开窗），壳层自己跟踪并复用
    private weak var mainWindow: NSWindow?
    /// 系统标题栏命中层盖住 WebView 顶缘；本地监听补「双击缩放」
    private var titlebarZoomMonitor: Any?
    private var lastTitlebarClick: (time: TimeInterval, point: NSPoint)?

    /// MainView 的 WindowAccessor 探针拿到窗口后调用：只装标题栏双击 zoom。
    func attachWindowChrome(to window: NSWindow) {
        mainWindow = window
        installTitlebarZoomMonitor(for: window)
    }

    /// 隐藏标题栏仍有系统 titlebar 命中层（拖窗/红绿灯），默认不响应双击缩放。
    /// 手动双击判定（titlebar 上 clickCount 不可靠）→ 与绿键相同的 zoom(nil)。
    private func installTitlebarZoomMonitor(for window: NSWindow) {
        if let existing = titlebarZoomMonitor {
            NSEvent.removeMonitor(existing)
            titlebarZoomMonitor = nil
        }
        lastTitlebarClick = nil
        titlebarZoomMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseUp]) { [weak self, weak window] event in
            guard let self, let window, event.window === window else { return event }
            let titlebarH = Self.titlebarHitHeight(for: window)
            let fromTop = window.frame.height - event.locationInWindow.y
            guard fromTop >= 0, fromTop <= titlebarH else {
                self.lastTitlebarClick = nil
                return event
            }
            if Self.hitWindowButton(window: window, event: event) {
                self.lastTitlebarClick = nil
                return event
            }
            let now = event.timestamp
            let pt = event.locationInWindow
            let isDouble: Bool
            if event.clickCount >= 2 {
                isDouble = true
            } else if let last = self.lastTitlebarClick,
                      now - last.time <= NSEvent.doubleClickInterval,
                      hypot(pt.x - last.point.x, pt.y - last.point.y) <= 6 {
                isDouble = true
            } else {
                isDouble = false
            }
            if isDouble {
                self.lastTitlebarClick = nil
                window.zoom(nil)
                return nil
            }
            self.lastTitlebarClick = (now, pt)
            return event
        }
    }

    private static func titlebarHitHeight(for window: NSWindow) -> CGFloat {
        if let container = window.standardWindowButton(.closeButton)?.superview {
            return max(container.frame.height, 28)
        }
        return 28
    }

    private static func hitWindowButton(window: NSWindow, event: NSEvent) -> Bool {
        let buttons: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
        for type in buttons {
            guard let btn = window.standardWindowButton(type),
                  let parent = btn.superview else { continue }
            let p = parent.convert(event.locationInWindow, from: nil)
            if btn.frame.insetBy(dx: -2, dy: -2).contains(p) { return true }
        }
        return false
    }

    /// web 主题（data-theme 经消息桥回报）——保留入口；目前无原生控件需跟随
    func applyWebTheme(dark: Bool) {
        _ = dark
    }

    /// 前置 app 并确保主窗口存在：已跟踪到窗口就复用（置前/取消最小化），
    /// 没有才 openWindow 新建——openWindow(id:) 在窗口已存在时不保证复用，不能依赖
    func showMainWindow() {
        NSApp.activate(ignoringOtherApps: true)
        if let window = mainWindow ?? findExistingMainWindow() {
            mainWindow = window
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.makeKeyAndOrderFront(nil)
        } else {
            openWindowAction?()
        }
    }

    /// 关窗后 weak mainWindow 已空时，复用仍存活的可成为 key 的内容窗（排除菜单栏 NSPanel）
    private func findExistingMainWindow() -> NSWindow? {
        NSApp.windows.first { window in
            !(window is NSPanel)
                && window.canBecomeKey
                && window.contentView != nil
        }
    }

    func openInbox() {
        showMainWindow()
        guard let url = pageURL("/inbox") else { return }
        navigator.navigate(to: url)
    }

    // MARK: - 壳层命令

    func newDoc() {
        showMainWindow()
        guard let url = pageURL("/new") else { return }
        navigator.navigate(to: url)
    }

    /// ⌘K 命令面板（菜单兜底）：文本输入会话下 macOS 输入系统会吞掉 ⌘K
    /// （页面收不到、只蜂鸣）。菜单先拦截，再向页面派发合成 keydown——
    /// Layout 的 window capture 监听照常处理（isEditing 守卫语义不变）。
    func toggleCommandPalette() {
        dispatchKeyEvent("k")
    }

    /// ⌘J AI 聊天（同 ⌘K：输入框聚焦时会被输入系统拦截）
    func toggleAiChat() {
        dispatchKeyEvent("j")
    }

    private func dispatchKeyEvent(_ key: String) {
        navigator.evaluate(
            "window.dispatchEvent(new KeyboardEvent('keydown',{key:'\(key)',code:'Key\(key.uppercased())',metaKey:true,bubbles:true,cancelable:true}))"
        )
    }

    func openSettings() {
        showMainWindow()
        guard let url = pageURL("/settings") else { return }
        navigator.navigate(to: url)
    }

    /// 设置 → 关于（Logo / 版本 / 手动检查更新）
    func openAbout() {
        showMainWindow()
        guard let url = pageURL("/settings/about") else { return }
        navigator.navigate(to: url)
    }

    /// 复制本机 MCP 地址（供本机 AI agent 接入）
    func copyMCPAddress() {
        guard let url = mcpURL else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url.absoluteString, forType: .string)
        showTransientMessage("MCP 地址已复制")
    }
}
