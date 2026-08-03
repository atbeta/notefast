import XCTest
@testable import NoteFast

/// EngineProcess 单测：
/// - parseHandshake：纯函数，各种 stdout 行
/// - 进程机制：用临时假「engine 脚本」验证 spawn / 握手 / 优雅停机 / 提前退出
final class EngineProcessTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("nf-engine-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tempDir)
    }

    // MARK: - parseHandshake

    func testParseHandshake_normal() {
        let line = #"NF_READY {"port":55150,"version":"0.31.0","notebookId":"nb-1","apiPath":"/api/v1","mcpPath":"/mcp"}"#
        let hs = EngineProcess.parseHandshake(line: line)
        XCTAssertEqual(hs?.port, 55150)
        XCTAssertEqual(hs?.version, "0.31.0")
        XCTAssertEqual(hs?.notebookId, "nb-1")
        XCTAssertEqual(hs?.apiPath, "/api/v1")
        XCTAssertEqual(hs?.mcpPath, "/mcp")
    }

    func testParseHandshake_optionalFieldsMissing() {
        let line = #"NF_READY {"port":1000,"version":"0.1.0"}"#
        let hs = EngineProcess.parseHandshake(line: line)
        XCTAssertEqual(hs?.port, 1000)
        XCTAssertEqual(hs?.version, "0.1.0")
        XCTAssertNil(hs?.notebookId)
    }

    func testParseHandshake_ignoresNoiseLines() {
        XCTAssertNil(EngineProcess.parseHandshake(line: ""))
        XCTAssertNil(EngineProcess.parseHandshake(line: "[log] 🚀 NoteFast Server running at http://localhost:3140"))
        XCTAssertNil(EngineProcess.parseHandshake(line: "NF_READY not-json"))
        XCTAssertNil(EngineProcess.parseHandshake(line: "PREFIX_READY {\"port\":1}"))
    }

    func testParseHandshake_trailingWhitespace() {
        let line = "NF_READY {\"port\":1,\"version\":\"v1\"}  \n"
        XCTAssertEqual(EngineProcess.parseHandshake(line: line)?.port, 1)
    }

    // MARK: - spawn / handshake / shutdown

    private func makeFakeEngine(script: String) throws -> URL {
        let engineDir = tempDir.appendingPathComponent("engine", isDirectory: true)
        try FileManager.default.createDirectory(at: engineDir, withIntermediateDirectories: true)
        let bin = engineDir.appendingPathComponent("notefast-server")
        try script.write(to: bin, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bin.path)
        return engineDir
    }

    func testStart_readsHandshakeAndStops() throws {
        let engineDir = try makeFakeEngine(script: """
        #!/bin/sh
        echo 'NF_READY {"port":55150,"version":"0.31.0","notebookId":"nb-1"}'
        trap 'exit 0' TERM
        while true; do sleep 1; done
        """)
        let engine = EngineProcess(engineDir: engineDir, dataDir: tempDir.appendingPathComponent("data"))
        let hs = try engine.start(timeout: 5)
        XCTAssertEqual(hs.port, 55150)
        XCTAssertEqual(hs.version, "0.31.0")
        XCTAssertTrue(engine.isRunning)

        engine.stop(wait: 3)
        XCTAssertFalse(engine.isRunning)
    }

    func testStart_timeoutWhenNoHandshake() throws {
        let engineDir = try makeFakeEngine(script: """
        #!/bin/sh
        trap 'exit 0' TERM
        while true; do sleep 1; done
        """)
        let engine = EngineProcess(engineDir: engineDir, dataDir: tempDir.appendingPathComponent("data"))
        XCTAssertThrowsError(try engine.start(timeout: 0.3)) { error in
            XCTAssertEqual(error as? EngineError, .handshakeTimeout)
        }
        XCTAssertFalse(engine.isRunning)
    }

    func testStart_processExitsBeforeHandshake() throws {
        let engineDir = try makeFakeEngine(script: "#!/bin/sh\nexit 3\n")
        let engine = EngineProcess(engineDir: engineDir, dataDir: tempDir.appendingPathComponent("data"))
        XCTAssertThrowsError(try engine.start(timeout: 5)) { error in
            XCTAssertEqual(error as? EngineError, .processExited(3))
        }
    }

    func testStart_binaryMissing() throws {
        let missing = tempDir.appendingPathComponent("nope", isDirectory: true)
        let engine = EngineProcess(engineDir: missing, dataDir: tempDir.appendingPathComponent("data"))
        XCTAssertThrowsError(try engine.start(timeout: 1)) { error in
            guard case .binaryNotFound = error as? EngineError else {
                return XCTFail("预期 binaryNotFound，得到 \(error)")
            }
        }
    }
}
