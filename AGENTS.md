# AGENTS.md

AI 编码 Agent 与人类协作者的本仓库级行为规范。

## 指令优先级

1. 当前对话中的用户请求
2. 本 `AGENTS.md`（monorepo 中以最近目录为准）
3. 源代码与测试
4. 其他文档（`README`、`CONTRIBUTING`、嵌套的 `AGENTS.md`、skills）

若指令冲突，遵从前一优先级项并简要说明冲突。

## 默认工程偏好

以下规则适用于本仓库，除非项目专属章节另有说明。

### 包管理器

| 场景 | 工具 | 说明 |
|------|------|------|
| 安装依赖 | `bun install` | 替代 npm/pnpm，使用 bun.lock |
| Bun 版本 | `.bun-version`（现钉 `1.3.14`） | CI / Docker / engine 同源；升级须改此文件并验证 Windows engine 杀软误报（不走代码签名） |
| 运行脚本 | `bun run <script>` | 或简写 `bun <script>` |
| Monorepo | `bun --filter <pkg> <script>` | `clients/` 不是 Bun workspace，勿用 `bun --filter '*'` 扫到它 |

### 变更纪律

- 满足请求的最小完整变更
- 编辑前先阅读相关代码，复用已有模式
- 不在同一变更中顺手重构无关代码
- 不提交密钥、凭证、`.env` 文件
- 行为变更时同步添加或更新测试（纯文档除外）
- 功能分支合回 `main` 默认 `--ff-only`，避免多余 merge commit

### Commit messages

Conventional Commits，简洁英文。`type(scope): subject`，subject ≤ 72 字符、单一意图。类型：`feat` `fix` `perf` `refactor` `style` `docs` `test` `chore` `ci`。暂存文件 ≥ 4 时正文用 2–6 条 bullet 写 why / impact。

### 校验

改动完成前运行与变更范围匹配的检查；若跳过，说明原因。

质量门禁：`bun lint`（oxlint，`.oxlintrc.json`，correctness 为 error）+ `bun run typecheck` + `bun test`，由 `.github/workflows/ci.yml` 强制执行。

---

## 技术栈：TypeScript（Bun）

- **Bun** 作为运行时与包管理器，不使用 npm/pnpm/yarn
- 遵循已有框架模式（React、Hono、CodeMirror 6），不引入平行技术栈
- 优先使用类型化 API，避免 `any` 扩散
- 代码注释和文档使用中文；用户可见文案走 web i18n（`zh-CN` + `en`）

```bash
bun install
bun lint
bun test
bun run typecheck
bun run build
```

---

## 项目：NoteFast

AI-first 知识库 — block 级 API + MCP。AI 负责写入与理解，人类负责阅读；写作体验是正轨，不是整站副产品。

### 目录结构

```
notefast/
├── packages/core      # 共享类型与数据模型（纯库）
├── packages/server    # REST API + MCP + SQLite
├── packages/web       # React 阅读 / 编辑器
├── clients/apple      # macOS Swift 壳（非 Bun workspace）
├── clients/tauri      # Windows Tauri 壳（非 Bun workspace）
├── docs/              # backup.md / capture.md
├── docker-compose.yml
└── bun.lock
```

原生壳约定见 `clients/README.md`：壳只做 UI 与进程管理，业务全部在 `packages/server`。

### 命令（本仓库）

```bash
# 开发
bun install
bun --filter @notefast/server dev
bun --filter @notefast/web dev

# 质量
bun lint
bun test
bun run typecheck

# 构建与部署
bun run build
bun run build:engine
docker compose up -d
```

### 项目专属规则

#### 数据与存储

- **Block 是原子单位**：不允许绕过 block 模型直接操作原始文件；`block.content` 存行内 Markdown，块级结构通过 children 表达
- **SQLite 单文件**是权威存储，位于 `data/`；不为单用户知识库引入 Qdrant/pgvector 等独立向量库。向量经 sqlite-vec，是可重建二级索引
- **blocks / block_refs 读写走 `server/src/store/`**，不要另开 SQL 旁路
- **图片**：主数据在 `data/media/<sha256>`（内容寻址），Markdown 用 `asset:<sha256>`；引用靠内容扫描，不建关联表。备份 SQLite 快照不覆盖 media，需另行纳入卷/文件级备份
- **Markdown 仅作表达与导出**，不是权威存储。便携导出/归档可把 tags、时间、`notefast_id` 投影为 YAML frontmatter；导入可读 tags，不按 id 静默覆盖
- **备份与归档分轨**：灾备 = 应用内 SQLite→S3 快照（设置页 / `docs/backup.md`），恢复走停服 `bun --filter @notefast/server backup:restore`。Markdown 归档（LocalFS/S3/WebDAV）是单向便携副本，仅手动触发，会丢 ID/引用等元数据
- 备份、多端同步、Markdown 归档共用 `data/storage-locations.json` 里的对象存储连接，各自引用 locationId + 前缀，配置文件不内嵌凭据

#### 产品边界

- **API/MCP first**：能力先经 API 暴露，再补 UI。扩展走 MCP / 连接器 / 内部钩子，不做 Obsidian 式社区插件宇宙
- **AI 是第一公民**：外部 MCP 与内部 API 双通道。零模型配置须优雅降级——基础读写与词法检索可用，AI 入口隐藏/禁用，不要报错墙
- **文档默认对 AI 可见**。`properties.ai_exclude: true` 只挡 AI 索引 / MCP 发现与按 ID 读取；人类 Web、多端同步、备份仍带全文。禁止把 ai_exclude 当成不同步、删除或 `is_erased` tombstone
- **单 Notebook**；组织靠 tag + 智能视图，不主推多笔记本 UI。侧栏按对象分「笔记 / 资源 / 关系」。侧栏「最近访问」是本机打开足迹，与首页「最近更新」分开
- AI 助手不常驻左侧导航（⌘J / ⌘K / 顶栏 / 情境「问 AI」）。新模型槽（chat/embedding/reranker）默认「自定义」空表单，不按 locale 预选云端厂商
- **PWA** 只做可安装壳（manifest + 图标 + safe-area），不做 Service Worker / 离线缓存。Web 运行时零外部 CDN：字体经 `@fontsource-variable/*` 自托管，禁止恢复 Google Fonts 等外链
- 内部 AI 只做采集 / 理解 / 检索 / 维护；通用聊天客户端能力外放给 MCP 消费方

#### 鉴权与契约

- **单用户**：`AUTH_PASSWORD`（Web）+ `API_TOKEN`（API/MCP Bearer）。未配置任何鉴权 = 免鉴权（本地开发默认），不要靠自动生成 `data/api.key` 把实例翻成强制登录
- **`/api/v1` 只做加法**：删端点或改响应形状须 bump 版本或双版本过渡。原生壳只消费稳定子集（docs/blocks/search/sync protocol）
- Release Please 启用 `bump-minor-pre-major`：0.x 阶段 conventional commits 的 `!` 只升 minor，避免误跳 1.0.0

#### 客户端

- 客户端 = 某版本 engine 产物的快照；启动经 `/api/v1/version` 做最低版本校验。构建：`bun run build:engine` → `packages/server/dist-engine/`
- 内嵌引导 `packages/server/src/native/bootstrap.ts` 只听 127.0.0.1；stdout 是机器握手（`NF_READY <json>`），常规日志走 stderr
- Docker 须显式打包 sqlite-vec 原生扩展（linux amd64/arm64 的 `vec0`），不能依赖完整 `node_modules`

#### Agent 易踩坑

- **软删除向量必须隔离**：search / 全量索引均过滤 `is_deleted = 0`，否则幽灵命中。不要轻易 bump `VECTOR_INDEX_VERSION`（JSON 后端会按版本硬过滤，bump 会让既有库搜索全空）
- **`bun test` 共享一个进程**：鉴权 env 必须 save/restore；还原未设置的变量用 `delete process.env.X`，不能赋 `undefined`（Bun 会写成字符串 `"undefined"`）
- **SSE**：`relaxSseIdleTimeout` 必须注册在任何 `app.route()` 之前；停机先 `closeAllSseStreams()` 再 `server.stop`
- 同步 `publishChanges` 必须照常附带 ai_exclude 文档的 block 状态，不能当成 tombstone
