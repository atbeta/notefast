# NoteFast Windows 客户端（Tauri 壳）

Windows 桌面客户端 = **Tauri 壳 + 内嵌 server engine**（复用 `packages/server` 的
`build:engine` 产物）。壳层只做进程管理与窗口，业务（block 模型 / 检索 / AI / MCP /
同步）全部在 engine 内，壳层零重写。

## 架构

```
┌───────────────── NoteFast.exe（Tauri）────────────────┐
│  Rust 壳                                             │
│   ├─ engine.rs    spawn notefast-server.exe          │
│   │               └─ NF_READY 握手 → 入口 URL         │
│   ├─ ui/          最小启动页（invoke engine_start → 跳转）│
│   └─ WebView2     加载 engine 的 web-dist（?native=tauri）│
└──────────────┬───────────────────────────────────────┘
               │ 127.0.0.1:随机端口（trustedLocal 免鉴权）
               ▼
     内嵌 engine（notefast-server.exe）
       └─ SQLite（%APPDATA%/com.notefast.desktop/data）+ media/
```

- **数据目录**：`%APPDATA%/com.notefast.desktop/data`（等价 macOS 壳的
  `~/Library/Application Support/NoteFast/`）
- **入口 URL**：`http://127.0.0.1:{port}/?native=tauri`——Web 端 `index.html` 已按
  `native=tauri` 启用壳模式（`[data-drag-region]` 等）
- **优雅停机**：Windows 无 SIGTERM，Rust 侧退出时 `POST /internal/shutdown`
  （bootstrap 内部路由，仅回环 + trustedLocal 可及）→ engine drain → 关 DB；
  8s 超时未退则 TerminateProcess 兜底

## 开发

前置：Bun + Rust 工具链（WebView2 Runtime：Win11 自带 / Win10 通常已装）。

```bash
# 1. 构建 engine 产物（含 web-dist；每次 server/web 代码变更后重跑）
cd D:\Code\notefast
bun --filter @notefast/web build
bun run build:engine

# 2. 启动壳（dev 模式：自动探测 packages/server/dist-engine，无需设环境变量；
#    如需覆盖可用 $env:NOTEFAST_ENGINE_DIR = "..."）
cd clients\tauri
bun install          # 首次：拉取 @tauri-apps/cli（已声明在 package.json）
bun dev              # 等价 bun run dev → tauri dev
```

dev 模式不打包，engine 直接跑 `dist-engine/` 产物；改动 Rust 代码热重建，
改动 server/web 代码需重跑 `build:engine`。

## 打包（P0 后阶段）

```bash
# 一站式：构建 engine → 复制进 src-tauri/resources/engine → NSIS 安装包
bun run build:full
# 产物：src-tauri\target\release\bundle\nsis\NoteFast_0.x.x_x64-setup.exe
```

- engine 产物（~60MB exe + vec0.dll + web-dist）经 `bundle.resources` 进安装包，
  运行时 `resources/engine/` 是壳定位引擎的路径（dev 模式自动探测 dist-engine）
- CI：`.github/workflows/windows-client.yml`（PR/push 冒烟：cargo check/clippy +
  engine 构建 + NSIS 打包）与 `windows-release.yml`（tag 触发，上传 GitHub Release）
- 发布期需 Authenticode 签名（未签名 exe 首次运行会触发 SmartScreen 提示；
  release workflow 暂未配置签名，证书就绪后补）

## 与 macOS 壳的对应关系

| 能力 | macOS（clients/apple） | Windows（本目录） |
|---|---|---|
| 进程管理 | `EngineProcess.swift` | `src-tauri/src/engine.rs` |
| 握手 | `parseHandshake`（NF_READY 前缀扫描） | `parse_handshake`（同契约） |
| 停机 | SIGTERM | `POST /internal/shutdown` + 超时强杀 |
| dev 定位 engine | `NOTEFAST_ENGINE_DIR` | 同 |
| UI 复用 | WKWebView 加载 engine 页面 | WebView2 加载 engine 页面（同源，天然无桥） |
| 打开外链 | `NSWorkspace` 拦截 http(s)/mailto | `tauri-plugin-opener`（`opener:default`） |
