#if os(macOS)
import Foundation
import Darwin

/// 内嵌 engine 启动握手（对应 server 侧 `bootstrap.ts` 的 `NF_READY <json>`）。
public struct EngineHandshake: Codable, Equatable {
    public let port: Int
    public let version: String
    public let notebookId: String?
    public let apiPath: String?
    public let mcpPath: String?
    /// vault 模式才有：规范化后的 vault 根目录（引擎回报，壳层据此显示来源）
    public let vaultPath: String?
    /// vault 模式才有：引擎实际使用的 DATA_DIR（= 应用支持目录/<sha256 前 12 位>）
    public let dataDir: String?
}

public enum EngineError: Error, LocalizedError, Equatable {
    case binaryNotFound(String)
    case alreadyRunning
    case launchFailed(String)
    case handshakeTimeout
    case processExited(Int32)

    public var errorDescription: String? {
        switch self {
        case .binaryNotFound(let path):
            return "找不到内嵌 engine：\(path)。请先执行 `bun run build:engine` 并组装 .app"
        case .alreadyRunning:
            return "engine 已在运行"
        case .launchFailed(let detail):
            return "engine 启动失败：\(detail)"
        case .handshakeTimeout:
            return "engine 握手超时（未在时限内收到 NF_READY）"
        case .processExited(let code):
            return "engine 进程提前退出（code=\(code)）"
        }
    }
}

/// 内嵌 NoteFast engine 进程管理。
///
/// 契约（见 server `src/native/bootstrap.ts`）：
/// - spawn（普通 db notebook）：`notefast-server --data-dir <dir> --assets-dir <engineDir>`
/// - spawn（vault 模式）：`notefast-server --vault-path <folder> --app-support-dir <dir> --assets-dir <engineDir>`；
///   **DATA_DIR 不由壳计算**，引擎按 `sha256(canonical vault path)` 前 12 位派生到应用支持目录
///   （一个 vault 一个索引，RFC 0001 D4）——派生口径只留在引擎侧，壳不复制业务规则
/// - **stdout 是机器握手通道**：常规日志全部在 stderr，启动成功后写一行 `NF_READY <json>`；
///   客户端按 `NF_READY ` 前缀扫描即可容错
/// - SIGTERM 触发 engine 优雅停机（drain 在飞请求 + 关闭 DB），stop() 等待后再强退兜底
public final class EngineProcess {
    public let engineDir: URL
    /// 普通模式的数据目录；vault 模式下不使用（引擎自行派生，见 `vaultPath`）
    public let dataDir: URL
    /// vault 根目录；nil = 普通 db notebook 模式
    public let vaultPath: URL?
    /// 每 vault 索引的父目录（应用支持目录）；仅 vault 模式传给引擎
    public let appSupportDir: URL?

    private var process: Process?
    private var pipe: Pipe?
    private var stdoutBuffer = Data()
    private let bufferLock = NSLock()
    private let resolveLock = NSLock()
    private var resolved = false
    private var outcome: Result<EngineHandshake, Error> = .failure(EngineError.handshakeTimeout)
    private let ready = DispatchSemaphore(value: 0)
    /// 握手成功后进程意外退出的回调（stop() 主动停机不触发）；在任意队列触发，回调方自行切换 actor
    public var onUnexpectedExit: ((Int32) -> Void)?
    /// stop() 主动停机标记：区分「我们杀的」与「意外崩溃」
    private var stopping = false

    public init(engineDir: URL, dataDir: URL, vaultPath: URL? = nil, appSupportDir: URL? = nil) {
        self.engineDir = engineDir
        self.dataDir = dataDir
        self.vaultPath = vaultPath
        self.appSupportDir = appSupportDir
    }

    public var isRunning: Bool { process?.isRunning ?? false }

    public var isVaultMode: Bool { vaultPath != nil }

    public var engineBinaryURL: URL {
        engineDir.appendingPathComponent("notefast-server")
    }

    /// 从一行 stdout 解析握手。容忍前缀噪声（客户端按 NF_READY 前缀扫描）。
    public static func parseHandshake(line: String) -> EngineHandshake? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let range = trimmed.range(of: "NF_READY ") else { return nil }
        let json = String(trimmed[range.upperBound...])
        guard let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(EngineHandshake.self, from: data)
    }

    /// 启动参数（纯函数，便于单测）：
    /// - vault 模式：`--vault-path <folder> --app-support-dir <dir>`，**不传 --data-dir**——
    ///   引擎按 sha256 派生每 vault 的 DATA_DIR（壳不复制这条规则）
    /// - 普通模式：`--data-dir <dir>`
    public static func launchArguments(
        engineDir: URL,
        dataDir: URL,
        vaultPath: URL? = nil,
        appSupportDir: URL? = nil
    ) -> [String] {
        var args = ["--assets-dir", engineDir.path]
        if let vaultPath {
            args += ["--vault-path", vaultPath.path]
            if let appSupportDir {
                args += ["--app-support-dir", appSupportDir.path]
            }
        } else {
            args += ["--data-dir", dataDir.path]
        }
        return args
    }

    /// 启动并阻塞等待握手；timeout 内未收到 NF_READY 则终止进程并抛 .handshakeTimeout。
    @discardableResult
    public func start(timeout: TimeInterval = 15) throws -> EngineHandshake {
        guard FileManager.default.fileExists(atPath: engineBinaryURL.path) else {
            throw EngineError.binaryNotFound(engineBinaryURL.path)
        }
        guard !isRunning else { throw EngineError.alreadyRunning }
        if vaultPath != nil && appSupportDir == nil {
            throw EngineError.launchFailed("vault 模式缺少 appSupportDir（每 vault 索引的父目录）")
        }
        // 普通模式建数据目录；vault 模式建应用支持目录（派生索引目录由引擎自建）
        let dirToCreate = vaultPath == nil ? dataDir : (appSupportDir ?? dataDir)
        try FileManager.default.createDirectory(at: dirToCreate, withIntermediateDirectories: true)

        let proc = Process()
        proc.executableURL = engineBinaryURL
        // 不传 --port：bootstrap 默认固定端口（origin 稳定 → localStorage 持久，主题/语言不丢）
        proc.arguments = Self.launchArguments(
            engineDir: engineDir,
            dataDir: dataDir,
            vaultPath: vaultPath,
            appSupportDir: appSupportDir
        )
        let outPipe = Pipe()
        proc.standardOutput = outPipe
        // stderr 落盘日志（~/Library/Logs/NoteFast/engine.log）：不进握手通道，但出问题时要有线索可查
        let logHandle = Self.openLogFile()
        proc.standardError = logHandle ?? FileHandle.nullDevice
        proc.terminationHandler = { [weak self] p in
            guard let self else { return }
            if !self.resolved {
                // 握手窗口内提前退出：报启动失败
                self.resolve(.failure(EngineError.processExited(p.terminationStatus)))
            } else if !self.stopping {
                // 运行期意外崩溃：通知壳层（stop() 主动停机已置 stopping，不触发）
                self.onUnexpectedExit?(p.terminationStatus)
            }
        }

        do {
            try proc.run()
        } catch {
            throw EngineError.launchFailed(error.localizedDescription)
        }
        // 子进程已继承 stderr fd，父进程副本立即关闭防泄漏
        try? logHandle?.close()
        process = proc
        pipe = outPipe

        outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.consumeStdout(handle)
        }

        if ready.wait(timeout: .now() + timeout) == .timedOut {
            // 超时：终止并等待退出，保证 start() 返回时进程已清理
            stop(wait: 2)
            throw EngineError.handshakeTimeout
        }
        return try outcome.get()
    }

    /// SIGTERM 优雅停机（engine drain + 关 DB）；超时未退则 SIGKILL 兜底。
    public func stop(wait: TimeInterval = 10) {
        stopping = true
        guard let proc = process, proc.isRunning else { return }
        proc.terminate() // SIGTERM → engine bootstrap 优雅停机
        let deadline = Date().addingTimeInterval(wait)
        while proc.isRunning && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        if proc.isRunning {
            kill(proc.processIdentifier, SIGKILL)
        }
    }

    private func consumeStdout(_ handle: FileHandle) {
        let data = handle.availableData
        guard !data.isEmpty else { return }
        var handshake: EngineHandshake?
        bufferLock.lock()
        stdoutBuffer.append(data)
        while let nl = stdoutBuffer.firstIndex(of: 0x0A) {
            let lineData = stdoutBuffer.subdata(in: 0..<nl)
            stdoutBuffer.removeSubrange(0...nl)
            guard let line = String(data: lineData, encoding: .utf8) else { continue }
            if let hs = Self.parseHandshake(line: line) {
                handshake = hs
                break
            }
        }
        bufferLock.unlock()
        if let hs = handshake {
            resolve(.success(hs))
        }
    }

    /// 只成功一次：握手与终止竞争时以先到为准，防止成功被终止错误覆盖。
    private func resolve(_ result: Result<EngineHandshake, Error>) {
        resolveLock.lock()
        if resolved {
            resolveLock.unlock()
            return
        }
        resolved = true
        outcome = result
        resolveLock.unlock()
        ready.signal()
    }

    // MARK: - 日志

    /// engine stderr 日志路径：~/Library/Logs/NoteFast/engine.log
    public static func logFileURL() -> URL {
        let base = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("Logs/NoteFast/engine.log")
    }

    /// 打开日志文件（超 4MB 截断重写，只留最近一段），启动失败回退 nil（调用方用 nullDevice 兜底）
    private static func openLogFile() -> FileHandle? {
        let url = logFileURL()
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            if !FileManager.default.fileExists(atPath: url.path) {
                FileManager.default.createFile(atPath: url.path, contents: nil)
            }
            if let size = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int,
               size > 4 * 1024 * 1024 {
                try Data().write(to: url) // 截断
            }
            let handle = try FileHandle(forWritingTo: url)
            try handle.seekToEnd()
            let marker = "\n--- engine start \(ISO8601DateFormatter().string(from: Date())) ---\n"
            handle.write(Data(marker.utf8))
            return handle
        } catch {
            return nil
        }
    }

    deinit {
        pipe?.fileHandleForReading.readabilityHandler = nil
        if let p = process, p.isRunning {
            p.terminate()
        }
    }
}
#endif
