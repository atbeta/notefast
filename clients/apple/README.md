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

- 内嵌 server 生命周期：spawn（`--data-dir / --assets-dir`）→ stdout `NF_READY` 握手 → 退出 SIGTERM drain；**运行期崩溃自愈**（engine 意外退出 → 失败态 UI 一键重试）
- WKWebView 内容区（`/?native=macos`，全窗口 Web 应用，隐藏式标题栏）
- 导航策略：同源放行（target=_blank 当前页打开）、**外链交系统浏览器**、下载（`<a download>`/blob 导出/不可展示 MIME）存 `~/Downloads` 重名自动加序号
- 菜单栏：⌘N 新建笔记、⌘, 设置、⌘[ ⌘] 后退/前进、⌘+ ⌘- ⌘0 缩放、⌘P 打印、⌘R 刷新、复制本机 MCP 地址、显示 engine 日志/数据目录
- engine stderr 落盘 `~/Library/Logs/NoteFast/engine.log`（>4MB 截断，只留最近一段）
- **菜单栏常驻图标**（NSStatusItem，SF Symbol 模板渲染）：显示主窗口 / 新建笔记 / 打开收集箱 / 退出
- **关窗不退出**：关窗后驻留菜单栏/Dock，点 Dock、菜单栏项、深链、文件导入均重建主窗口（`openWindow(id:)` 注入 + `start()` 幂等守卫防二次 spawn）
- 多端同步：web 端 GlobalSyncStatus 胶囊 + 设置页同步面板呈现
- 深链：`notefast://doc/<id>`、`notefast://search?q=xxx`（命令面板预填搜索，Info.plist 已注册 URL scheme）
- 窗口标题跟随页面 `<title>`；engine 版本校验（低于 0.31.0 出阻断页，可「仍要继续」）
- 轻量更新检查：启动后静默查 GitHub Releases，有新版发系统通知 + 帮助菜单「下载新版」（非 Sparkle，只指路）
- 系统通知：`WKScriptMessageHandler` 桥（web 侧 `lib/nativeNotify.ts`，同步失败转场去重后推送）+ 壳层自身（engine 崩溃 / 新版本）
- 组装脚本支持 Developer ID 签名 + `notarize.sh` 公证链路（CI：`macos-release.yml` 签名/公证/DMG/Release 全自动）

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
- P3：系统分享（NSSharingService / 分享扩展——成本=整套沙盒+App Group 改造，价值低，暂搁置）、自动更新升级 Sparkle/appcast（当前为轻量检查+指路，装机量值得时再上）
- P4：MCP 本机 agent 引导
- iOS：同一 SPM 包加 app target（不内嵌 engine，同步协议直连 S3）

## 已确认决策

- **关窗不退出 + 菜单栏图标**（2026-08，替代此前的「关窗即退出」）：两者是一套——菜单栏图标提供驻留入口，关窗后 app 靠它/Dock/深链回访；退出走 ⌘Q 或菜单栏「退出」
