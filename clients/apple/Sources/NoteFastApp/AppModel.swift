import SwiftUI
import AppKit
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
    @Published var syncActionMessage: String?

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

    // MARK: - 生命周期

    func start() async {
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
        do {
            let hs = try engine.start(timeout: 20)
            state = .running(hs)
            engineVersion = hs.version
            verifyEngineVersion(hs.version)
            navigator.navigate(to: entryURL ?? URL(string: "http://127.0.0.1")!)
            drainPendingImports()
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

    // MARK: - 打开即导入（.md 文件关联：双击/拖到 Dock → 导入收集箱并打开）

    /// engine 未就绪时暂存的待导入文件（app 经文件打开冷启动的场景）
    private var pendingImportFiles: [URL] = []

    /// AppDelegate 的 openFile(s) 入口：非 .md 后缀不接收（plist 已过滤，双保险）
    func importMarkdownFile(at url: URL) {
        let exts: Set<String> = ["md", "markdown", "mdown", "mkd"]
        guard exts.contains(url.pathExtension.lowercased()) else { return }
        guard isRunning else {
            pendingImportFiles.append(url)
            return
        }
        Task { await importMarkdownFiles([url]) }
    }

    private func drainPendingImports() {
        let files = pendingImportFiles
        pendingImportFiles = []
        guard !files.isEmpty else { return }
        Task { await importMarkdownFiles(files) }
    }

    /// 导入为 inbox 文档：单篇直接打开（满足「双击为了看」的场景，页面带升格/丢弃入口）；
    /// 多篇跳收集箱列表批量整理
    private func importMarkdownFiles(_ files: [URL]) async {
        guard case .running(let hs) = state, let base = baseURL else { return }
        guard let notebookId = hs.notebookId else {
            showTransientMessage("导入失败：engine 握手缺少 notebookId")
            return
        }
        let client = NoteFastClient(baseURL: base)
        var firstDocId: String?
        var imported = 0
        for file in files {
            guard let markdown = try? String(contentsOf: file, encoding: .utf8), !markdown.isEmpty else {
                showTransientMessage("无法读取：\(file.lastPathComponent)")
                continue
            }
            do {
                let res = try await client.post("/import/markdown", body: [
                    "notebook_id": notebookId,
                    "title": file.deletingPathExtension().lastPathComponent,
                    "markdown": markdown,
                    "status": "inbox",
                ], as: ImportMarkdownResult.self)
                if firstDocId == nil { firstDocId = res.doc.id }
                imported += 1
            } catch {
                let apiError = (error as? NotefastAPIError)
                showTransientMessage("导入失败：\(file.lastPathComponent)（\(apiError?.message ?? "未知错误")）")
            }
        }
        guard imported > 0 else { return }
        showTransientMessage(files.count > 1 ? "已导入 \(imported) 篇到收集箱" : "已导入到收集箱")
        if imported == 1, let docId = firstDocId, let url = docURL(docId) {
            navigator.navigate(to: url)
        } else if let url = pageURL("/inbox") {
            navigator.navigate(to: url)
        }
    }

    // MARK: - 深链（notefast://）与文件打开

    func handle(url: URL) {
        // SwiftUI onOpenURL 在 macOS 上同时承接「打开文件」事件（file://）——
        // AppDelegate 的 openFile(s) 未必会触发，这里兜底打开即导入
        if url.isFileURL {
            importMarkdownFile(at: url)
            return
        }
        guard url.scheme == "notefast", isRunning else { return }
        switch (url.host, url.pathComponents) {
        case ("doc", let parts) where parts.count >= 2:
            if let target = docURL(parts[1]) { navigator.navigate(to: target) }
        case ("new", _):
            if let url = pageURL("/new") { navigator.navigate(to: url) }
        case ("search", _):
            if let url = pageURL("/") { navigator.navigate(to: url) }
        default:
            break
        }
    }

    // MARK: - 壳层命令

    func newDoc() {
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
        guard let url = pageURL("/settings") else { return }
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
