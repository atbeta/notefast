import Foundation
import Darwin

/// 内嵌 engine 启动握手（对应 server 侧 `bootstrap.ts` 的 `NF_READY <json>`）。
public struct EngineHandshake: Codable, Equatable {
    public let port: Int
    public let version: String
    public let notebookId: String?
    public let apiPath: String?
    public let mcpPath: String?
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
/// - spawn：`notefast-server --data-dir <dir> --port 0 --assets-dir <engineDir>`
/// - **stdout 是机器握手通道**：常规日志全部在 stderr，启动成功后写一行 `NF_READY <json>`；
///   客户端按 `NF_READY ` 前缀扫描即可容错
/// - SIGTERM 触发 engine 优雅停机（drain 在飞请求 + 关闭 DB），stop() 等待后再强退兜底
public final class EngineProcess {
    public let engineDir: URL
    public let dataDir: URL

    private var process: Process?
    private var pipe: Pipe?
    private var stdoutBuffer = Data()
    private let bufferLock = NSLock()
    private let resolveLock = NSLock()
    private var resolved = false
    private var outcome: Result<EngineHandshake, Error> = .failure(EngineError.handshakeTimeout)
    private let ready = DispatchSemaphore(value: 0)

    public init(engineDir: URL, dataDir: URL) {
        self.engineDir = engineDir
        self.dataDir = dataDir
    }

    public var isRunning: Bool { process?.isRunning ?? false }

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

    /// 启动并阻塞等待握手；timeout 内未收到 NF_READY 则终止进程并抛 .handshakeTimeout。
    @discardableResult
    public func start(timeout: TimeInterval = 15) throws -> EngineHandshake {
        guard FileManager.default.fileExists(atPath: engineBinaryURL.path) else {
            throw EngineError.binaryNotFound(engineBinaryURL.path)
        }
        guard !isRunning else { throw EngineError.alreadyRunning }
        try FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)

        let proc = Process()
        proc.executableURL = engineBinaryURL
        proc.arguments = ["--data-dir", dataDir.path, "--port", "0", "--assets-dir", engineDir.path]
        let outPipe = Pipe()
        proc.standardOutput = outPipe
        // stderr 不接管：engine 日志（含启动告警）不进握手通道
        proc.standardError = FileHandle.nullDevice
        proc.terminationHandler = { [weak self] p in
            // 进程提前退出（或我们 stop 后的正常退出）：若握手未成功则报错，否则忽略
            self?.resolve(.failure(EngineError.processExited(p.terminationStatus)))
        }

        do {
            try proc.run()
        } catch {
            throw EngineError.launchFailed(error.localizedDescription)
        }
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

    deinit {
        pipe?.fileHandleForReading.readabilityHandler = nil
        if let p = process, p.isRunning {
            p.terminate()
        }
    }
}
