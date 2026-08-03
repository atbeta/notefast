# NoteFast Apple 客户端（macOS / iOS）

SwiftUI 壳 + 内嵌 NoteFast engine（Bun 编译的 `notefast-server`）。macOS 现役，
iOS 后续复用同一 Swift 工程（不内嵌 server，走同步协议直连 S3 或连自部署 server）。

## 架构

```
SwiftUI App（NoteFastApp）
  ├── EmbeddedServer/EngineProcess   # spawn engine + NF_READY 握手 + SIGTERM 停机
  ├── API/NoteFastClient             # URLSession REST（对齐 packages/core 契约）
  ├── WebNavigator                   # 壳层→WebView 导航桥（菜单/深链/工具栏）
  └── UI/                            # 侧栏文档列表 + WKWebView 内容区 + 同步面板
```

## 已实现（P0 壳 + 阅读为主）

- 内嵌 server 生命周期：spawn（`--data-dir / --port 0 / --assets-dir`）→ stdout `NF_READY` 握手 → 退出 SIGTERM drain（SSE 长连接兜底 ~10s）
- 原生侧栏文档列表（选中态驱动 WebView 导航）+ WKWebView 内容区（`/?native=macos`）
- 菜单栏：⌘N 新建笔记（覆盖默认 New Window）、⌘R 刷新、复制本机 MCP 地址
- 工具栏：同步状态指示（绿/橙/灰 + 待发布角标）、新建、设置（跳转 web `/settings`）
- 多端同步面板：状态轮询（10s）、立即同步、从云端恢复（`/sync/protocol/pull`，带确认）
- 深链：`notefast://doc/<id>`（Info.plist 已注册 URL scheme）
- 窗口标题跟随页面 `<title>`；engine 版本校验（低于 0.31.0 提示不兼容）
- 组装脚本支持 Developer ID 签名 + `notarize.sh` 公证链路

## 构建

```bash
# 一次性：构建 engine 产物（packages/server/dist-engine/）
bun run build:engine

# 组装 NoteFast.app（release + 注入 engine + 签名）
./scripts/assemble-app.sh                       # ad-hoc（本地开发）
./scripts/assemble-app.sh --sign "Developer ID Application: <名字>"   # 发布
./scripts/notarize.sh --sign "Developer ID Application: <名字>"       # 发布 + 公证

# 开发：仅编译/测试 Swift 代码
swift build
swift test
```

## 运行前提

- 本机需已执行 `bun run build:engine`（app bundle 内嵌 `dist-engine` 产物快照）
- dev 模式（`swift run`）：`NOTEFAST_ENGINE_DIR=../packages/server/dist-engine swift run NoteFastApp`
- 数据目录 `~/Library/Application Support/NoteFast/`（首次启动自动创建）
- 免鉴权模式（engine 未配置 AUTH_PASSWORD）：回环 trustedLocal 自动放行，无需登录

## 待办（规划）

- P1：⌘S 显式保存（web autosave 已覆盖，需菜单项时加）、原生搜索/标签面板
- P2：同步配置面板（S3 连接，当前复用 web 设置页）
- P3：系统分享（NSSharingService）、菜单栏图标、Developer ID 签名流水线验证
- P4：⌘J 聊天面板原生入口（web 已有，WKWebView 内可达）、MCP 本机 agent 引导
- iOS：同一 SPM 包加 app target（不内嵌 engine，同步协议直连 S3）
