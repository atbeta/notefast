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
    @Published var syncStatus: SyncProtocolStatus?
    @Published var engineVersion: String?
    @Published var versionIncompatible = false
    @Published var syncActionMessage: String?

    let navigator = WebNavigator()

    private var engine: EngineProcess?
    private var terminateObserver: NSObjectProtocol?
    private var pollTask: Task<Void, Never>?
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
        pollTask?.cancel()
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
            await refreshSyncStatus()
            startSyncPolling()
        } catch {
            state = .failed(error)
        }
    }

    func restart() {
        stop()
        Task { await start() }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
        engine?.stop(wait: 8)
        engine = nil
        syncStatus = nil
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

    // MARK: - 同步（多端同步协议：自动同步由 engine 负责，壳层只做状态展示 + 手动触发）

    private func startSyncPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                await self?.refreshSyncStatus()
            }
        }
    }

    func refreshSyncStatus() async {
        guard let base = baseURL else { return }
        do {
            let client = NoteFastClient(baseURL: base)
            syncStatus = try await client.get("/sync/protocol", as: SyncProtocolStatus.self)
        } catch {
            // 轮询失败静默（engine 重启窗口期）
        }
    }

    /// 手动触发一轮同步（publish + consume；engine 内部已有去抖自动同步）
    func syncNow() async {
        guard let base = baseURL else { return }
        showTransientMessage("正在同步…")
        do {
            let client = NoteFastClient(baseURL: base)
            _ = try await client.post("/sync/protocol/run", as: SyncRunResult.self)
            await refreshSyncStatus()
            showTransientMessage("同步完成")
        } catch {
            let apiError = (error as? NotefastAPIError)
            showTransientMessage(apiError?.message ?? "同步失败")
        }
    }

    /// 消费端首次恢复：从 S3 拉全量快照/增量合并到本地（会替换本地库，需用户确认后调用）
    func syncPull() async {
        guard let base = baseURL else { return }
        showTransientMessage("正在从云端恢复…")
        do {
            let client = NoteFastClient(baseURL: base)
            let result = try await client.post("/sync/protocol/pull", as: SyncPullResult.self)
            await refreshSyncStatus()
            let mode = result.mode == "full" ? "全量恢复" : "增量合并"
            showTransientMessage("\(mode)完成（应用 \(result.applied ?? 0) 条）")
        } catch {
            let apiError = (error as? NotefastAPIError)
            showTransientMessage(apiError?.message ?? "恢复失败")
        }
    }

    private func showTransientMessage(_ message: String) {
        syncActionMessage = message
        transientMessageTask?.cancel()
        transientMessageTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled else { return }
            self?.syncActionMessage = nil
        }
    }

    // MARK: - 深链（notefast://）

    func handle(url: URL) {
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
