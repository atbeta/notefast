# NoteFast Apple 客户端（macOS / iOS）

SwiftUI 壳 + 内嵌 NoteFast engine（Bun 编译的 `notefast-server`）。macOS 现役，
iOS 后续复用同一 Swift 工程（不内嵌 server，走同步协议直连 S3 或连自部署 server）。

## 架构

```
SwiftUI App（NoteFastApp）
  ├── EmbeddedServer/EngineProcess   # spawn engine + NF_READY 握手 + SIGTERM 停机
  ├── API/NoteFastClient             # URLSession REST（对齐 packages/core 契约）
  └── UI/                            # 侧栏文档列表 + WKWebView 内容区（/ ?native=macos）
```

## 构建

```bash
# 一次性：构建 engine 产物（packages/server/dist-engine/）
bun run build:engine

# 组装 NoteFast.app（release 构建 + 注入 engine + ad-hoc 签名）
./scripts/assemble-app.sh

# 开发：仅编译/测试 Swift 代码
swift build
swift test
```

## 运行前提

- 本机需已执行 `bun run build:engine`（app bundle 内嵌 `dist-engine` 产物快照）
- 数据目录 `~/Library/Application Support/NoteFast/`（首次启动自动创建）
- 免鉴权模式（engine 未配置 AUTH_PASSWORD）：回环 trustedLocal 自动放行，无需登录
