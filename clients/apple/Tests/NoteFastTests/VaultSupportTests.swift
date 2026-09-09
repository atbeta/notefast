import XCTest
@testable import NoteFast

/// 壳侧 vault 支持单测：
/// - `RecentVaults`：去重 / 置顶 / 截断 / 增删（UserDefaults 用独立 suite）
/// - `EngineProcess.launchArguments`：vault 模式传 `--vault-path` + `--app-support-dir` 且不传 `--data-dir`
final class VaultSupportTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUpWithError() throws {
        suiteName = "notefast.tests.recentVaults.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
    }

    // MARK: - RecentVaults

    func testRememberKeepsNewestFirst() {
        let store = RecentVaults(defaults: defaults)
        _ = store.remember("/Users/x/VaultA")
        let list = store.remember("/Users/x/VaultB")
        XCTAssertEqual(list.map(\.path), ["/Users/x/VaultB", "/Users/x/VaultA"])
        XCTAssertEqual(store.all().map(\.path), ["/Users/x/VaultB", "/Users/x/VaultA"])
    }

    func testRememberDedupesAndPromotes() {
        let store = RecentVaults(defaults: defaults)
        _ = store.remember("/Users/x/A")
        _ = store.remember("/Users/x/B")
        // 尾斜杠 + 大小写不同视为同一文件夹（macOS 卷默认不敏感）
        let list = store.remember("/Users/x/a/")
        XCTAssertEqual(list.map(\.path), ["/Users/x/a", "/Users/x/B"])
    }

    func testRememberCapsEntries() {
        let store = RecentVaults(defaults: defaults)
        for i in 0..<(RecentVaults.maxEntries + 5) {
            _ = store.remember("/Users/x/Vault\(i)")
        }
        let list = store.all()
        XCTAssertEqual(list.count, RecentVaults.maxEntries)
        XCTAssertEqual(list.first?.path, "/Users/x/Vault\(RecentVaults.maxEntries + 4)")
    }

    func testRemoveAndClear() {
        let store = RecentVaults(defaults: defaults)
        _ = store.remember("/Users/x/A")
        _ = store.remember("/Users/x/B")
        XCTAssertEqual(store.remove("/Users/x/a").map(\.path), ["/Users/x/B"])
        store.clear()
        XCTAssertTrue(store.all().isEmpty)
    }

    func testNormalizeAndComparisonKey() {
        XCTAssertEqual(RecentVaults.normalize("/Users/x/Vault/"), "/Users/x/Vault")
        XCTAssertEqual(RecentVaults.normalize("/Users/x/sub/../Vault"), "/Users/x/Vault")
        XCTAssertEqual(RecentVaults.normalize("/"), "/")
        XCTAssertEqual(RecentVaults.comparisonKey("/Users/X/Vault"), "/users/x/vault")
        XCTAssertEqual(
            RecentVaults.normalized(["/a", "/a/", "", "/b", "/c", "/d"], keeping: 3),
            ["/a", "/b", "/c"]
        )
    }

    func testEntryNameFallsBackToPath() {
        XCTAssertEqual(VaultEntry(path: "/Users/x/My Vault").name, "My Vault")
        XCTAssertEqual(VaultEntry(path: "/Users/x/My Vault/").name, "My Vault")
        XCTAssertEqual(VaultEntry(path: "/").name, "/")
    }

    // MARK: - 启动参数（env 透传契约）

    func testLaunchArgumentsVaultModeOmitsDataDir() {
        let args = EngineProcess.launchArguments(
            engineDir: URL(fileURLWithPath: "/App/engine"),
            dataDir: URL(fileURLWithPath: "/Users/x/Library/Application Support/NoteFast"),
            vaultPath: URL(fileURLWithPath: "/Users/x/MyVault"),
            appSupportDir: URL(fileURLWithPath: "/Users/x/Library/Application Support/NoteFast")
        )
        XCTAssertEqual(args, [
            "--assets-dir", "/App/engine",
            "--vault-path", "/Users/x/MyVault",
            "--app-support-dir", "/Users/x/Library/Application Support/NoteFast",
        ])
        XCTAssertFalse(args.contains("--data-dir"), "vault 模式 DATA_DIR 必须由引擎派生")
    }

    func testLaunchArgumentsPlainMode() {
        let args = EngineProcess.launchArguments(
            engineDir: URL(fileURLWithPath: "/App/engine"),
            dataDir: URL(fileURLWithPath: "/Users/x/Library/Application Support/NoteFast")
        )
        XCTAssertEqual(args, [
            "--assets-dir", "/App/engine",
            "--data-dir", "/Users/x/Library/Application Support/NoteFast",
        ])
    }

    func testStartVaultModeWithoutAppSupportDirThrows() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("nf-vault-args-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let bin = dir.appendingPathComponent("notefast-server")
        try "#!/bin/sh\nexit 0\n".write(to: bin, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bin.path)

        // vault 模式必须给 appSupportDir：否则引擎会退回平台默认目录，与壳的显示不一致
        let engine = EngineProcess(
            engineDir: dir,
            dataDir: dir.appendingPathComponent("data"),
            vaultPath: dir
        )
        XCTAssertTrue(engine.isVaultMode)
        XCTAssertThrowsError(try engine.start(timeout: 1)) { error in
            guard case .launchFailed = error as? EngineError else {
                return XCTFail("预期 launchFailed，得到 \(error)")
            }
        }
    }
}
