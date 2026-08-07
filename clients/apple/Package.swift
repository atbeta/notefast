// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "NoteFast",
    platforms: [.macOS(.v14), .iOS(.v17)],
    targets: [
        // 可测试的库：进程管理 / API 客户端 / 模型（与 UI 解耦）
        .target(name: "NoteFast", path: "Sources/NoteFast"),
        // 可执行壳：SwiftUI + WKWebView（@main 入口）
        .executableTarget(name: "NoteFastApp", dependencies: ["NoteFast"], path: "Sources/NoteFastApp"),
        .testTarget(name: "NoteFastTests", dependencies: ["NoteFast"], path: "Tests/NoteFastTests"),
    ]
)
