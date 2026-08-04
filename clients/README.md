# NoteFast 客户端（原生壳）

一切平台 = UI 壳 + 复用 engine。业务（block 模型 / 检索 / AI / MCP / 同步）全部在
`packages/server`（内嵌引导 `src/native/bootstrap.ts` + `scripts/build-engine.ts` 产物），
客户端只做 UI 与进程管理，**不重写任何业务逻辑**。

## 目录布局

```
clients/
├── apple/        # Apple 平台：SwiftUI 壳（macOS 现役，iOS 后续复用同一 Swift 工程）
│   ├── Sources/NoteFast/   # 进程管理 / API 客户端 / SwiftUI UI
│   ├── Tests/NoteFastTests/
│   ├── Resources/          # 组装期注入：engine 产物、Info.plist、entitlements
│   ├── scripts/assemble-app.sh
│   └── Package.swift       # SPM（Swift 源码与未来 XcodeGen 生成 .xcodeproj 兼容）
└── tauri/        # Tauri 壳（当前仅 Windows，复用 web-dist；Linux 后续同一工程）
```

## 各平台形态

| 平台 | 技术 | 内嵌方式 | 状态 |
|---|---|---|---|
| **macOS** | SwiftUI + WKWebView | 内嵌 Bun server（`--compile` 单文件） | 开发中（P0 壳 + 阅读） |
| **iOS / iPadOS** | SwiftUI | 不内嵌（禁派生进程）→ 同步协议直连 S3 / 连自部署 server | 规划 |
| **Windows** | Tauri（WebView2） | 内嵌 Bun server（.exe + vec0.dll）+ 复用 web-dist | 开发中（P0 壳 + 阅读） |
| **Linux** | Tauri | 内嵌 Bun server + 复用 web-dist | 规划 |

## 关键约定

- 客户端 = **版本快照**：bundle 某版本 engine 产物，启动经 `/api/v1/version` 做最低版本校验
- 壳层只消费稳定 REST 子集（docs / blocks / search / sync protocol），不碰实验性端点
- `packages/server/src/native/bootstrap.ts` 的 stdout 是机器握手通道：
  启动成功后写 `NF_READY <json>`（port/version/notebookId），客户端扫描前缀解析
- 构建：`clients/apple/scripts/assemble-app.sh`（engine 产物 + swift build + 组装 .app + 签名）
