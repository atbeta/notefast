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
| 运行脚本 | `bun run <script>` | 或简写 `bun <script>` |
| Monorepo | `bun --filter <pkg> <script>` | 当 `bunfig.toml` 配置 workspaces 时使用 |

### 变更纪律

- 满足请求的最小完整变更
- 编辑前先阅读相关代码，复用已有模式
- 不在同一变更中顺手重构无关代码
- 不提交密钥、凭证、`.env` 文件
- 行为变更时同步添加或更新测试（纯文档除外）

### 校验

改动完成前运行与变更范围匹配的检查（见下方 **命令** 章节）。若跳过，说明原因。

质量门禁：`bun lint`（oxlint，配置见根 `.oxlintrc.json`，correctness 规则为 error）+ `bun run typecheck` + `bun test`，三者已由 `.github/workflows/ci.yml` 在 PR/push 时强制执行。

---

## 技术栈：TypeScript（Bun）

### 工具链

- **Bun** 作为运行时与包管理器，不使用 npm/pnpm/yarn
- Monorepo：通过 `bunfig.toml` 或 `package.json` workspaces 管理多包

### 命令

```bash
bun install
bun lint
bun test
bun run build          # 有构建流程时
```

### 约定

- 遵循已有框架模式（React、Hono 等），不引入平行技术栈
- 优先使用类型化 API，避免 `any` 扩散

---

## 项目：NoteFast

AI-first 知识库 — block 级 API + MCP，AI 负责写入与理解，人类负责阅读。

### 目录结构

```
notefast/
├── packages/
│   ├── core/                # 共享类型与数据模型（纯库，无运行时依赖）
│   │   └── src/
│   │       ├── types.ts     # Block、Notebook、API 契约与线格式类型
│   │       ├── model.ts     # Block 树操作（CRUD、移动、排序）
│   │       ├── markdown.ts  # Markdown ↔ Block 树互转
│   │       ├── search.ts    # FTS5 查询构建
│   │       ├── sync.ts / backup.ts / tags.ts / docStatus.ts / plugin.ts
│   │       ├── embedding.ts / llm.ts / reranker.ts   # Provider 接口
│   │       └── ai/          # config / presets / runtime / suggest / thinkSplit
│   │
│   ├── server/              # REST API + MCP Server
│   │   └── src/
│   │       ├── index.ts     # 入口，Hono 应用创建
│   │       ├── db.ts        # SQLite 初始化、migrations
│   │       ├── store/       # 数据访问层（blocks / block_refs / entity_changes / shares 的唯一读写入口）
│   │       ├── dbQueries.ts # FTS5 检索查询构建（runFtsQuery；blocks 普通读写不走这里）
│   │       ├── api/         # REST 路由（blocks, docs, search, refs, import, ai, sync, backup, autolink…）
│   │       ├── mcp/         # MCP Server 与 Tool 定义
│   │       ├── ai/          # indexer / chat / hybridSearch / autoLink / vectorStore / aiExclude
│   │       ├── sync/        # Markdown 归档适配器（LocalFS / S3 / WebDAV）+ 多端同步协议（protocol / protocolManager / protocolConfig）
│   │       ├── backup/      # SQLite→S3 快照备份
│   │       ├── services/    # aiRuntime / docImport / autoExport / hooks
│   │       ├── assets/      # 图片 AssetStore
│   │       ├── cli/         # backup:restore 等停服命令
│   │       └── middleware/  # 鉴权
│   │
│   └── web/                 # React Web 阅读器
│       └── src/
│           ├── App.tsx
│           ├── routes/      # home, doc, new, inbox, archived, settings, settings-ai
│           ├── components/  # BlockRenderer, MarkdownEditor, Sidebar, 设置面板等
│           └── hooks/       # useAPI（api 客户端 + ApiError）, useTheme
│
├── docker-compose.yml
├── Dockerfile
├── package.json             # workspace root
└── bun.lock
```

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
docker compose up -d
```

### 项目专属规则

- **API/MCP first**：所有能力先通过 API 暴露，再补 UI
- **Block 是原子单位**：不允许绕过 block 模型直接操作原始文件
- **SQLite 单文件**：数据库文件存于 `data/` 目录，不引入外部数据库
- **图片 AssetStore**：图片唯一主数据源为 `data/media/<sha256>`（内容寻址去重），`assets` 表只存元数据；Markdown 内存 `asset:<sha256>` 稳定引用；引用关系不建关联表，靠内容扫描推导；应用内 S3 快照覆盖 SQLite，`data/media` 仍需另行纳入卷/文件级备份
- **Markdown 行内存储**：block.content 存行内 Markdown，块级结构通过 children 表达
- **AI 是第一公民**：AI Agent 可通过 MCP（外部）或直接调用 API（内部嵌入）操作知识库
- **单用户 + Token 鉴权**：MVP 为单用户模式，通过 `AUTH_PASSWORD`（Web UI 密码）和 `API_TOKEN`（API/MCP Bearer Token）鉴权
- **单 Notebook**：单人笔记场景，默认自动创建「我的笔记」笔记本
- **中文文档与注释**：代码注释和文档使用中文，commit message 使用英文

### 待定事项

以下问题已确定：

1. 项目命名：NoteFast ✓
2. 认证机制：单用户模式，密码（Web UI）+ API Token（API/MCP）✓
3. AI Provider 集成：内部 API + 外部 MCP 双通道，AI 是第一公民 ✓
4. 多 Notebook：单 Notebook（单人笔记）✓
5. Web 编辑：基础 Markdown 编辑（复杂度可控时添加）✓

## Learned User Preferences

- 坚持 SQLite 单文件主库，不为单用户知识库引入 Qdrant/pgvector 等独立向量库作为默认依赖
- 向量层升级按「元数据与接口 → Docker 原生扩展验证 → sqlite-vec」推进，不以当前规模下的检索延迟为由插队
- 备份与 Markdown 归档分轨：单向 Markdown 推送不是灾难恢复；完整灾备用应用内 SQLite→S3 快照，恢复走停服 CLI
- 功能分支合回 `main` 默认 `--ff-only`，避免多余 merge commit
- 笔记组织优先 tag + 智能视图，不主推多笔记本 UI；底层保留单 Notebook 即可；侧栏不默认加「已分享」智能视图（访问面审计，非内容组织）
- 文档默认对 AI 可见；「对 AI 隐藏」入口应低调（勿用锁图标或「对 AI 可见」易被读成需点击才可见）；已隐藏态再显式状态与恢复；暂不需要全局「默认 AI 可见性」，少数敏感笔记手动 opt-out
- Markdown 富渲染优先接入 Mermaid；LaTeX/公式后续再做
- 人类写作体验视为正轨（非整站副产品）；可服务「同步写读找」轻量用户，不对打思源式块级 PKM 全家桶
- Markdown 仅作表达与导出，不作权威存储；主权靠自托管 SQLite + 可验证导出讲清楚，不为安抚退回文件夹 MD
- AI 设置三个模型槽（chat/embedding/reranker）新增时默认预设一律为「自定义」空表单（本地优先姿态，不按 locale 替用户预选云端厂商）；预设含 DashScope 阿里云百炼（chat `qwen3.8-max` / embedding `qwen3.7-text-embedding` / reranker `qwen3-rerank`，rerank 走 `compatible-api` 段的 `/reranks` 复数路径、Jina 风格协议，由 `createReranker` 按 aliyuncs.com 域名分派并把 baseUrl 的 `compatible-mode/v1` 替换为 `compatible-api/v1`——chat/embeddings 的 compatible-mode 不含 /reranks，2026 起调用即 404）；reranker 默认模型与 embedding 解耦，走预设的 `rerankerModel` 字段（SiliconFlow = `BAAI/bge-reranker-v2-m3`）
- 本地可写 SQLite 的原生客户端是一等拓扑；官方免配置 Sync 云暂缓；PWA 只做「可安装壳」（manifest + 图标 + meta + safe-area），**不做 Service Worker / 离线缓存**（避免内嵌原生壳拿到陈旧资源，离线能力归原生壳），手机与轻客户端优先复用现有 Web
- Web 运行时零外部 CDN 依赖（中国大陆部署友好）：字体经 `@fontsource-variable/*` npm 自托管（main.tsx 引入，family 名带 ` Variable` 后缀），**禁止恢复 Google Fonts 等外链**；mermaid 等均为 npm 打包
- MCP 做强：能力落在 NoteFast 自身 MCP/API，不为本地另封一层 API 调用；大文件建档正文不经 LLM，走 stage/upload 通道
- 分享 UI：顶栏轻量 popover（非全屏 modal）；已分享需可辨识图标态（如 Globe）；文档列表/侧栏项悬浮 `⋯` 菜单承载文档级操作（含导出）

## Learned Workspace Facts

- Release Please：`.github/release-please-config.json` 启用 `bump-minor-pre-major: true`，0.x 阶段 conventional commits 的 `!`（breaking）只升 minor，避免误跳 1.0.0
- 语义向量经 `VectorStore` 抽象；默认可为 JSON 后端，配置 embedding 后经索引重建切到 sqlite-vec；向量是可重建二级索引，SQLite 仍为权威数据
- api.key 鉴权：仅在显式配置了鉴权（AUTH_PASSWORD / READ_TOKEN / WRITE_TOKEN 任一，或 API_TOKEN 直给）时，initDb 才生成 `data/api.key` 并写入 env（供 MCP/API Bearer，重启加载既有 key 保持稳定）；**未配置任何鉴权 = 免鉴权模式（本地开发默认）——不生成也不加载 api.key**，全 admin 放行 + 启动醒目告警。自动 key 不应单方面把实例翻成强制鉴权（Web 无密码可登录只会全 401）。**密码变更会话轮换**：Web 登录生成的 web-session token（api_tokens 表，Bearer）与密码无关，改 `AUTH_PASSWORD` 后不会自然失效（cookie 侧 HMAC 会）；initDb 启动时比对 `data/auth.state.json` 的 `passwordFingerprint`（AUTH_PASSWORD 的 sha256，未配置=空串指纹），不一致（改/增/删密码）即 `revokeWebSessionTokens()` 批量撤销——旧会话下次请求 401，Web 端 fetchWithAuth 收 401 自动清 localStorage 并回登录页
- 公开分享安全头：`/s/*` 与 `/share/*` 统一带 `X-Frame-Options: DENY` + `CSP frame-ancestors 'none'`（防 iframe 嵌入/点击劫持）；分享页顶部有「公开分享页面」提示条；会话 cookie 在 HTTPS（直连或 X-Forwarded-Proto）下带 `Secure`；chat 工具 `notefast_read_doc` 成功读全文时发 `doc.read_by_agent` 审计事件（emitAppEvent）
- `block_vectors` 需记录 `embedding_model` / `content_hash` / `index_version`；模型或版本变化标记 stale，旧向量不参与检索；**软删除 block 的向量必须被隔离——两个后端 search 与 `indexAllBlocks` / `loadDocBlockIds` 均显式过滤 `is_deleted = 0`**（afterDelete hook 只清当次删除的向量，不过滤的全量/恢复重建会把软删块重新 embed 成「幽灵命中」：内容与新块近似、id 是死锚）
- 向量索引文本由 `ai/indexedText.ts` 的 `buildIndexedText(row)` 统一构建（增量 indexBlock/indexBlockBatch 与全量 runVectorRebuild 共用）：`标题：{doc 标题}` / `章节：{H1 / H2}`（沿 parent_id 上溯收集 heading，root 侧在前，深度上限 6，visited 防循环）/ `标签：{root 行 tags}` + 正文 + `[图片描述]`，空段省略、正文空则不索引；标题/章节/标签是「上下文」——afterUpdate 遇 document/heading 块、`PATCH /docs/:id/tags` 保存后均 scheduleDocIndex 整篇重索引（hasFreshVector 跳过未变块）
- AI Provider 停用语义：`ProviderDefinition.enabled?: boolean`（缺省 = 启用，旧配置免迁移；Reranker 早有同名字段）。**生效 = 配置存在 && enabled !== false**，收口在 `AiRuntime.reload()` 的 provider 构建处——停用即不构建，capabilities / status / hasChat/hasEmbedding 全部随之视为未配置，但配置（含 apiKey）保留在文件中可再启用；validateConfig / web localValidate 对停用 provider 跳过字段校验；**注意 `api/ai.ts` 的 zod `providerSchema` 必须带 `enabled`，否则 PUT 时 unknown key 被剥离、开关存不下来**。设置页 UI：Provider 卡片内 Toggle 取代原「移除」按钮（移除=丢配置，停用=留配置）
- 向量双 hash（schema v6 起，`block_vectors` / `vector_entries` 均有 `source_content_hash` 列）：**`content_hash` = buildIndexedText 输出 hash（freshness 判定）；`source_content_hash` = block.content 原文 hash（`upsertToGeneration` 并发写保护校验锚）**——vision/上下文让索引文本 ≠ 原文时增量 upsert 不再被自校验误拒；**不 bump `VECTOR_INDEX_VERSION`**（JSON 后端 search 硬过滤 index_version，bump 会让既有库搜索全空），旧向量靠 content_hash 不匹配自然过期，v6 迁移按 blocks 现内容 JOIN 回填 source_content_hash
- Docker 部署需显式打包 sqlite-vec 原生扩展（linux amd64/arm64 的 `vec0`），不能依赖完整 `node_modules`
- Markdown 归档（LocalFS/S3/WebDAV）是单向内容副本，会丢失 ID/引用/标签等元数据；完整灾备用应用内 SQLite→S3 快照（设置页 / `docs/backup.md`）
- Markdown 归档 = 便捷迁移 / 便携副本，**仅手动触发**：文档与引用的图片一起推送（`.md` + `media/<sha><ext>`，`asset:<sha>` 改写为相对路径，见 `sync/archiveMedia.ts`）；远端文件名为 `<slug>--<docId>.md`，由 `notefast-archive.manifest.json` 跟踪并清理陈旧文档与 media（`staleArchiveMedia`）；S3 与 WebDAV 适配器同时只能启用一个，且仅为单向 push
- 文档 markdown 导出在根写入 `# {title}` 为有意设计；编辑器加载需 strip 与标题同文的首 H1（含子块时提升其子块）
- 数据库备份配置在 `data/backup.config.json`；恢复须停服后跑 `bun --filter @notefast/server backup:restore`
- **对象存储抽象层** `server/src/storage/objectStore.ts`：`ObjectStore`（testConnection / putObject / getObject / listObjects / deleteObject / deleteObjects），备份（`backup/s3Store.ts` 的 `BackupStore` + `backup/mediaBackup.ts`）与多端同步（`sync/protocol.ts`）全部构建其上，现仅 S3 实现（`createS3ObjectStore`，key 为相对 bucket 的完整键）；加 WebDAV/LocalFS 只需新增 ObjectStore 实现。**存储连接库** `data/storage-locations.json`（`storage/locations.ts` + `api/storageLocations.ts`，支持 S3/WebDAV）：备份、多端同步、Markdown 归档三能力**共享连接、各自引用 locationId + 前缀**（能力配置 `backup.config.json` / `sync-protocol.config.json` + 状态 `sync-state.json` / `sync.config.json` 均不再内嵌凭据）；多端同步 `syncNow` 会上送 media 使同步位置自包含；seq 游标绑定「存储位置指纹」，换连接/前缀自动重置防漏发
- **向量存储是二进制 float32**（`block_vectors.embedding` BLOB，migration 007 由 JSON 文本原地转换；`vectorStore.ts` 的 encode/decode 兼容旧 JSON 行）——JSON 文本是 float32 的 ~5 倍，Qwen3-Embedding-8B(4096 维) 曾让 425M 库中 ~415M 是向量
- **快照剥离可重建的向量索引**（`backup/snapshot.ts` 的 `stripVectorIndexFromSnapshot`：清空 block_vectors/vec_blocks/vector_entries/generations + 置 stale + VACUUM，保留表结构）；备份与同步 compaction 快照均只含核心内容（KB~MB 级），恢复后语义搜索为空需手动 `POST /ai/index/rebuild` 重建
- **多端同步完全自动，无用户间隔配置**：写路径去抖触发（5s，`scheduleSyncNow` 覆盖 Web REST / import / AI chat / MCP 写工具，同步消费合并不触发避免环）+ 固定 60s 心跳（`syncHeartbeat` = 推送 + `safeMergeRemote` 增量合并远端，落后快照时不恢复自身、交给客户端全量拉取）
- **设备身份自持、无中心注册（peer 模型）**：Server 与客户端是对等写入者，共享同一份对象存储，不存在「向服务器注册」——身份=存储位置+凭据+自持 `device_id`（Server 存 `data/device.id`）；每条同步变更带 `device_id`（审计/推导设备集合），注册表=共享存储 `{prefix}sync/devices/<id>.json`（每设备一对象，无并发写冲突），API `GET/DELETE /sync/protocol/devices` 仅展示/移除记录，真实拦截靠用户更换 S3 凭证（scoped 由用户在存储控制台签发）
- 旧 Litestream Compose profile 与根目录 `litestream.yml` 均已移除（`-exec true` 会导致复制进程退出）；灾备统一走应用内 SQLite→S3 快照
- 文档组织：tag 多选默认 AND（同时包含），`tag_match=any` 为包含任一；智能视图为内置预设 + URL 参数（无自定义命名视图表）
- `properties.ai_exclude: true` 软隔离：不进向量/RAG/AutoLink/MCP 发现与按 ID 读取；人类 Web 列表/编辑/Cmd+K 仍可用；备份与 Markdown 归档仍含全文
- 收集箱：`properties.status: 'inbox'`；主列表 / tags 聚合 / MCP `list_docs` 默认排除；`GET /docs/list?status=inbox` 与侧栏「收集箱」；升格 `PATCH /docs/:id/status` → `note`
- AutoLink（AI 主动建链）：block 写入/更新后 AI 自动抽取锚点，高置信（语义命中 ≥ minConfidence 且 top-1 margin ≥ minMargin）直接写 `block_refs(ref_type='ai_auto')`，低置信静默跳过，无人工审核；ai_exclude / inbox / archived 文档均不参与；REST 仅 `POST /auto-link/run`、`POST /auto-link/run-batch`、`DELETE /auto-link/refs`；原「链接建议」审核页（`/autolink`）与 suggestions/inbox/apply/dismiss 等审核 API 已移除
- 归档：`blocks.status: 'archived'`（文档根显式列，无 CHECK 约束）；默认过滤语义统一为「仅 status='note'」（主列表 / tags 聚合 / MCP `list_docs` 同时排除 inbox 与 archived，`status=all` 全量）；AI 检索默认软排除归档（hybridSearch/semanticSearch 的 `includeArchived`、REST `/ai/search?include_archived=1`、chat `notefast_search_more` 的 `include_archived` 可显式包含）；Web 侧栏「归档」入口 + `/archived` 页 + 文档页归档/恢复（`PATCH /docs/:id/status`）；介于正常笔记与 ai_exclude 之间——保留内容、不再污染检索；创建路径不支持直接建归档
- 文档阅读/编辑预览用自定义 `BlockRenderer`，AI 聊天用 `react-markdown` + `remark-gfm`；mermaid 代码围栏经懒加载组件渲染并跟随 `data-theme`
- 阅读态块级菜单 v1（`components/BlockSurface.tsx`）：每个块左侧 gutter 浮 ⋮ handle（桌面 hover 显现 / 触屏常显淡化），菜单三项——复制块链接（`#block-<id>`，doc 页 hash 滚动现成）、复制块内容（core `blocksToMarkdown([block])` 含子块）、问 AI 关于这一段。注入点：`BlockNode` 外包 `BlockSurface`（wrapper 只加 `relative`，不加 margin/padding——块间距靠 `.reading-prose > * + *` 与外边距折叠，padding 会破坏折叠）；list_item 不走 wrapper（ul>li 语义），`BlockHandle` 直接挂 `li` 且**仅顶层**（嵌套项缩进后 handle 会压正文，复制/问 AI 由父项菜单含子块覆盖）；hr 无锚点不挂。原 heading 的 hover 锚链（Link2）已被该菜单吸收删除。**handle 可点性两个要点**：① 隐藏态只压 `opacity`，**绝不能加 `pointer-events-none`**——handle 在块盒外的 gutter，none 时它永远不是 hit 目标，鼠标移出块盒瞬间 group-hover 断开（鸡生蛋死锁，永远点不到）；② 按钮右缘与块边缘贴合（`-left-6` + `w-6`，-24..0）消灭 hover 死区；列表项 handle 在 `-left-[48px]`（**Tailwind v3 无 13 这个 spacing 值，必须 arbitrary**），li 盒外的 24px marker 区用 `before` 伪元素铺 hover 桥。「问 AI」走 `lib/askAi.ts` 的 `ASK_AI_EVENT` CustomEvent（仿 useEditorDraft 先例）：Layout 监听开面板、AIChatPanel 监听预填草稿（`chat.askAboutPrefix` 固定前缀 + `> ` 引用，截断 600 字，**不自动发送**，用户审阅后自发出；前缀占比即零埋点需求验证指标）。**手机（<sm）不出 handle**（16px 边距放不下 gutter + iOS 选区/键盘坑留待重构期）；v1 刻意不做：选区气泡、inline 结果卡、块类型特化、定位到大纲、CM 编辑器 toolbar
- blocks / block_refs 读写统一走 `server/src/store/`（blocks.ts / refs.ts）：函数级数据访问层而非 interface（单后端不冻结接口形状，未来换远程存储时以此为边界提取）；列表/树读取默认排除软删除，`updateBlock` 自动带 `updated_at`，content 变更自动同步 `content_hash`，软删除统一 `is_deleted + delete_id` tombstone 并级联清 block_refs；FTS 检索留 `dbQueries.runFtsQuery`（与 SQLite 共生，不进数据访问层）；向量 / assets 等自有表各留原 store
- `listDocRows` 排序带 rowid 决胜：updated_at 为毫秒精度（`nowTimestamp()` / SQL 侧 `strftime('%Y-%m-%d %H:%M:%f','now')`，同毫秒碰撞极低），ASC 按入库序（归档导出确定性），DESC 后入库在前（「最近更新」语义）
- 运行时杂项：indexJobs 终态作业保留最近 100 个（超出淘汰最老，pending/running 不动，防 Map 内存单调增长）；autoExport 兜底为自重排单循环（10s 首跑、跑完再计 1h，无双计时器叠加）；`Bun.serve` idleTimeout 保持默认 10s，SSE 路由（`/api/v1/events`、`/ai/chat`、`/ai/write`）经 `server.timeout(req, 60)` per-request 放宽——**relaxSseIdleTimeout 必须注册在任何 `app.route()` 之前**（Hono 按注册顺序执行，放路由后 = 死代码，SSE 会在 10s 被 Bun 掐断）；**停机 SSE 主动关闭**：`/api/v1/events` 是永久长连接，若任由 `server.stop` drain 会等满 10s 强退超时——`api/events.ts` 登记活跃流（`activeStreams`）并导出 `closeAllSseStreams()`，index.ts 与 native/bootstrap.ts 的 SIGTERM 停机路径在 `server.stop` 前调用（实测退出从 ~10s → 0.2s）
- **bun test 全部测试文件共享一个进程**（执行顺序不稳定、非字母序）：环境变量与模块级全局状态会跨文件残留——① 测试里设 AUTH_PASSWORD 等鉴权 env 再 initDb 会触发 api.key 生成并写入 `process.env.API_TOKEN`，必须 save/restore（**注意 Bun ≥1.2 里 `process.env.X = undefined` 会写入字符串 `"undefined"` 而非删除——还原未设置的变量必须显式 `delete process.env.X`**）；断言免鉴权行为的文件（如 createApp.test.ts）应在 beforeAll 清空四个鉴权 env 并在 afterAll 还原；② docEvents 的 pending/flushTimer 是模块级全局，前序文件真实写路径发布的事件会 flush 进后续文件的订阅——订阅方按 docId 过滤 + 用例前先 drain 一个 FLUSH_MS 窗口
- 文档列表/导出统一排除软删除文档：MCP `list_docs`/`list_tags`、sync 三适配器与 autoExport 原先不过滤 `is_deleted`，已对齐 Web 语义；软删除文档会在下次全量同步时经 manifest 从远端归档清理
- `updated_at` 语义 = 内容最后编辑时间（未来 LWW 裁决字段，客户端 push 可自带），**不做增量同步游标**；拉取游标用 `entity_changes.seq`（AUTOINCREMENT 单调递增，blocks 表 trigger 驱动，`store/changeFeed.ts` 只读封装）；change feed 清理策略待同步 API 落地时定，超窗客户端走全量快照重同步
- 文档分享：`shares` 表（doc_id → 公开 token，schema v4）独立存储，开关不写 blocks（不触发 updated_at/hooks/索引/change feed）；管理 API `GET/PUT/DELETE /docs/:id/share`（PUT 幂等，关闭即删记录，重开全新 token 旧链接永久失效；仅对未删除文档开放）；有效期 `expires_at` 默认 NULL=永不过期（Notion 同款），可选 1/7/30 天（以调整为起点重算），过期=未分享（读取时惰性清理，公开/管理端点统一只见未过期）；**删除文档级联清除 shares 行（docs/blocks/notebooks 三条删除路径），归档（PATCH status=archived）同样级联关闭分享，恢复文档/取消归档均不复活旧链接，需重新开启**；公开端点 `/share/:token`（markdown，`Cache-Control: no-store`）与 `/share/:token/assets/:sha256`（限本文引用的图片，非全站代理；`private, immutable` 缓存——浏览器可永久缓存但共享缓存/CDN 不得留存，防分享关闭后旧 URL 从缓存外泄；引用 sha 集合按 entity_changes `MAX(seq)` 做内存缓存，不写 Content-Length）挂在 `/api/*` 之外、无鉴权；Web 公开页 `/s/:token` 绕开 Layout/AuthPrompt，允许分享 inbox/archived 文档（显式行为覆盖默认过滤），ai_exclude 文档首次开启需 body 带 `confirm_ai_exclude: true`（否则 409 `ai_exclude_share_needs_confirm`，已开启后调有效期不再要求）；Web 分享面板为顶栏轻量 popover（非 modal），已分享顶栏用 Globe 态；`GET /docs/list` 响应带 `shared` 标记（仅有效分享，过期惰性清理），Web 文档列表项显示 Globe「已分享」徽标（与「AI 隐藏」徽标并列，store 层 `listSharedDocIds` 批量取）；MCP 分享工具未做
- 内部 AI 功能边界：只做「采集/理解/检索/维护」四类笔记核心行为；通用聊天客户端能力（多会话、语音对话、角色市场）与平台生态能力（Agent 运行时、插件市场）外放给 MCP 消费方；外部连接器未来可能做，已预留 `properties.source`（`{provider, external_id, synced_at}`）+ `findDocIdBySource()` 供 upsert
- 内置 skills：`server/src/ai/skills.ts` 注册表（prompt 模板，非 skill 运行时），`GET /ai/skills` 下发（`{{today}}` 服务端插值），聊天面板 chip 点击填入输入框；执行走现有 agent loop，写操作为建议模式；chat 工具含 `notefast_list_docs`（status/stale/updated 过滤）与 `notefast_read_doc`（读整篇 Markdown，12k 字符截断）；大文件建档用 `notefast_stage_markdown`（分块暂存）+ `notefast_create_doc_from_file`（`content` 或 `upload_id`），REST `POST /import/file` 共用入库，`create_doc` 仅适合短 Markdown；`/ai/chat` SSE 每 10s 写 `ping` 帧防 idleTimeout/代理断连（前端无匹配分支自然忽略）
- 图片理解：`vision.enabled` 设置开关（默认关）；索引时 `asset_captions`（schema v3，按 asset sha256 缓存）生成 caption 拼入索引文本（hash/freshness 以拼接后文本为准）；聊天图片走 `ChatMessage.content` 多模态 parts（base64 data URL，仅当轮发送，历史保持纯文本）；能力经 `/ai/capabilities` 的 `vision` 字段下发
- 中文词法检索走 `server/src/lexicalSearch.ts`（FTS5 + LIKE 双路合并）：unicode61 不切分 CJK，无空格中文查询在 FTS5 里是一个整 token 短语，只命中被标点/空格包围的完全相同字串；trigram 分词器有 2 字词死区（「笔记」「主权」不进索引），已验证不可用。LIKE 路对所有 term 做子串 AND（CJK 召回主力，SQLite LIKE 对 ASCII 不区分大小写；`%`/`_` 用 `ESCAPE '\'` 转义防注入），严格 AND 零结果时 OR 降级（`strictOnly` 可禁，autoLink 保精度），排序权重整句命中 > 命中 term 数 > 标题命中；FTS 路仅在有 ASCII term 时跑（bm25），合并时 LIKE 在前、FTS 按 bm25 补充，`rank_score` 为列表内合成相对分（非跨通道可比分）。hybridSearch / web `/search` / MCP `notefast_search` / autoLink `findCandidates` 四处统一走这里（autoLink 原 try/catch LIKE 降级已上移）；api/ai 的 `ftsHits`（mode=fts 调试通道）保持纯 FTS。hybridSearch 另有标题通道（`titleOnly`，只查文档根块，limit 5 + strictOnly）作为 rrfMerge 第三个 RRF 输入列表，ftsLimit 默认从 20 提到 60（LIKE 零成本扩大召回，抵消后置过滤吃名额）
- 检索评测体系：`packages/server/src/eval/`（runEval.ts CLI + evalCore.ts 共享核心 + fixtures/ 合成语料 40 篇 + queries 60 条）。用法：`bun --filter @notefast/server eval --corpus <corpus.json> --queries <queries.json> [--report out.json] [--topk 20]`；`--mock` 为 CI 模式（确定性字符袋 64 维 embedding，只验证管线接线不断，不断言语义质量）；默认活体模式读 `$DATA_DIR/ai.config.json`（或 `--config`）用真实 provider，seed 后 `indexAllBlocks` 全量建索引。指标：Doc Recall@10、Block Recall@20（relevant_blocks 内容子串在 top20 citation 正文覆盖率）、MRR（首个相关 citation 倒数排名）、nDCG@10（二元相关性）、expect_empty 查询 top-1 semantic cosine 均值/最大（无答案噪声，仅信号指标不硬断言）、延迟 P50/P95、按 query type 分组。CI 冒烟在 `__tests__/eval.test.ts`（fixtures 子集跑管线不变量：过滤态文档零泄漏 / gibberish FTS 零命中 / citation 可回查）。私有集：`bun --filter @notefast/server eval:private`（generatePrivateEval.ts 只读打开 `$DATA_DIR/notefast.db`，只取标题/tags/时间戳不导出正文，规则生成 ≤80 条查询到 `data/eval/private-queries.json`，已 gitignore）。评测是 hybridSearch 的只读消费方，不改检索行为；标注宁缺毋滥，relevant_docs 按标题引用语料
- 图谱数据层（schema v7）：两类边——`block_refs`（block↔block 引用）与 `entity_mentions`（block→entity 提及，entities/entity_mentions 两表，store/entities.ts），**同源于 autoLink 一次 LLM 抽取**：mentions 全量登记实体（`ai/entities.registerMentions`，不过 kind、不吃 maxPerBlock），kind 过滤与语义门槛只作用于建链（`block_refs ai_auto`）；EXTRACT prompt 已放宽为含工具/项目名、最多 5 个、kind concept/person/tool/doc；**抽取质量两道闸**：① prompt 排除代码标识符（含 `_`/`.` 符号名）与泛化/评价性短语，版本号后缀只保留主名；② `registerMentions` 的 `looksLikeCodeIdentifier` 确定性拦截代码标识符（连字符与纯词名不受影响），**版本变体归并** `resolveVersionVariant`（store/entities）把「既有主名 + 显式分隔版本后缀」（codemirror 6 → codemirror）路由到主名实体，主名不存在不猜测、名称本身含数字（fts5/bm25）不动、kind=doc 例外（编号文档是不同文档）。归并=规范化名精确匹配（normalizeEntityName：trim→lowercase→去首尾标点→压缩空白，全角不转换，宁多勿错并）；mention_count 冗余计数、归零删实体。三原则落点：hook 沿用 ai_exclude/inbox/archived 过滤（文档根 entitiesOnly 只登记不建链，标题长度下限 3 字）；afterUpdate 双清理（deleteRefsFromSource + deleteMentionsFromSource）后重抽；软删级联 `deleteMentionsTouchingBlocks` 与 deleteRefsTouchingBlocks 同挂三处删除路径；ai_exclude 开启时 purge 物理删 mentions（进检索必须清，不同于 refs 自然收敛），取消排除与升格（inbox/archived→note）均 `reanalyzeDoc` 全 doc 重抽（fire-and-forget，限速自然生效）。检索：实体召回路 `ai/entitySearch.ts`（normalized 精确 > 双向 LIKE 子串，mention_count 倒序，空表短路）为 rrfMerge 第四路，过同一套 drop 过滤。REST：`GET /api/v1/entities`（q/limit）、`GET /api/v1/entities/:id`（mentions 人类视角全量含 doc_status，ai_exclude 已 purge 天然安全）、`GET /api/v1/docs/:id/entities`（本篇去重）。存量回填走既有 `POST /auto-link/run-batch`，不自动全库跑
- 图谱 UI：实体共现图（`store/graph.ts` + `GET /api/v1/graph` + Web `/graph` 页，d3-force 力导向 SVG）。实体为节点（大小=mention_count、颜色=kind）、共现为边（同一活文档内被提及，权重=共享文档数）；`center`（entity/doc 锚点 BFS 扩展 depth≤3）/ `min_mention`（默认 2，锚点豁免）/ `kind` / `max_nodes` / `max_edges` 裁剪，总览=全库 top-N + `truncated` 标志；人类视角不过滤 inbox/archived（与 /entities 页一致）、ai_exclude 已 purge。**图只反映当前内容——全部查询过滤 `is_deleted=0`**：软删块上的提及是「删除后异步抽取竞态」的残留（afterCreate 抽取 fire-and-forget + 限速延迟可达数秒，文档在抽取完成前被整篇替换 → 替换路径清理先跑、抽取后到），不是合法数据；写入端 `registerMentions`（ai/entities.ts，登记前校验 `getLiveBlockById`）与 `doAnalyze`（ai/autoLink.ts 顶部 + 建链前二次校验，reason `source_deleted`）均对软删块拒绝登记/建链，堵住竞态源头；真删除文档的提及由 store 级联（deleteMentionsTouchingBlocks）物理清除。交互：缩放/平移/节点拖拽/悬停高亮邻居/单击选中（详情面板：相关实体 chips + 相关笔记）/双击或搜索聚焦/kind 筛选；侧栏「图谱」入口。视觉体系（EntityGraph.tsx）：屏幕空间点阵背景；实体节点 = kind 色 + 白色 sheen 高光 + 常驻淡光晕 + 共享 `feDropShadow` 投影；笔记节点 = 迷你卡片（`--graph-note-fill` 底色 + 细边 + primary 竖条 + 文本行 glyph，标题在卡片下方）；悬停/选中时相关边染焦点节点颜色；标签带 `--card` halo（paint-order: stroke）；**图结构变化自动 fit-to-view**（跟随布局收敛持续取景，用户缩放/平移/拖节点即停，容器 resize 不重置视角）；力导向带弱向心力（forceX/forceY，收紧孤立节点点云让总览缩放更高）；标签按缩放显隐（`view.k < 0.55` 时仅悬停/选中节点显示，tooltip 不受限）。注意：SVG 的 fill/stroke 不支持 CSS `var()`（token 是裸三元组），必须 `rgb(var(--…))` 包装；节点 pointer capture 须设在节点 `<g>` 而非 svg（否则 click 被重定向到 svg，onSelect 不触发）
- 融合层最终形态（hybridSearch）：5 路 RRF（k=60）——词法（FTS+LIKE）、语义、标题、实体、图谱上下文（`ai/graphContext.ts`，仅 `contextDocId` 存在时出票：当前文档自身块 cap 5 > block_refs 双向互链文档每 doc 2 块总 cap 10 > 共享实体文档每 doc 1 块总 cap 10，列表顺序即票序，过同一套 ai_exclude/inbox/archived drop 过滤；旧 `applyContextBoost` 绝对加分已删）。**score 尺度**：配 reranker 时为模型原始分（去掉了 [0.5,1] min-max 归一化，bge 系经验 0.3~0.9 需按模型校准 minScore），未配时为 RRF 融合分（~0.016-0.066）；`Citation.rrf_score` 恒为 RRF 融合分（rerank 后也保留，诊断用），retrieval report 带 `score_kind: 'rerank' | 'rrf'`。**多样性**：融合/精排后、`slice(0, topK)` 前 `applyDocDiversity`——每 doc 先取 ≤maxPerDoc 条（`SearchOptions.maxPerDoc` 默认 2，RAG chat 内部调用传 3），不足 topK 按分从溢出补齐
- Web 编辑器基于 CodeMirror 6（`packages/web/src/components/editor/CodeMirrorEditor.tsx` + `cm/` 子模块），替代原裸 textarea：底层始终是 Markdown 源码（零转换、无 round-trip 风险），装饰层做混合渲染（Typora-lite）。**排版体系与阅读态一致**（对齐 Obsidian 做法：编辑态复用阅读排版）：正文 16px `var(--font-sans)` / 行高 1.75，标题 = BlockRenderer 的 28/24/20px（1.75/1.5/1.25em），`var(--font-mono)` 只用于行内代码与代码块（0.85em + 淡底色），标记符压暗；图片与表格 widget 预览。**高亮样式两个坑**：① `editorHighlight` 必须定义泛型 `t.heading` 基准规则——`defaultHighlightStyle`（fallback）给泛型 heading 加了 bold+underline，而 lezer 给「表格表头行」打的正是泛型 heading（`TableHeader/...: tags.heading`），不定基准就会被 fallback 命中；② **lezer 会把「ATX 标题后无空行直接跟的表格」误解析为 SetextHeading2**（表头行+分隔行=文字+下划线），该表格在语法树里不是 Table——源码态表头会套用 heading2 样式（仅观感问题，阅读态 core 解析与 tablePreview 的正则扫描都不受影响）；调试编辑器语法树可用控制台 `__cmView`（CodeMirrorEditor 挂载时暴露在 window 上）。要点：**block 级 Decoration 必须由 StateField 提供**（ViewPlugin 只支持行内装饰）；widget 统一模式为「光标/选区在块内显示源码、块外渲染 widget，点击 widget 光标入块（mousedown 必须 `preventDefault + stopPropagation`，否则 CM 指针选区在 widget 销毁后把光标映射到块外，立即弹回 widget）」，实现见 `cm/imagePreview.ts` 与 `cm/tablePreview.ts`（表格块检测对齐 core/markdown.ts 的 isTableRow/isTableDelimiter，跳过 ``` 围栏内部防误判）；**CM 只渲染视口行**（.cm-line 仅视口内几十行，DOM 探测长文档须先滚动）；**改 cm/ 主题后 HMR 不会重建 EditorView，必须整页刷新才生效**（EditorView 在 useEffect 里只创建一次）；列表/引用续行与空项退出用 lang-markdown 自带 `insertNewlineContinueMarkdown`；` ``` ` + Enter 展开空代码块是自定义 keymap（`cm/keymap.ts`）；AI ghost text 走 `cm/ghostText.ts` 的 StateField + widget（Tab 接受 / Esc·输入取消）；图片粘贴/拖拽经 `EditorView.domEventHandlers` 转交 `useImageUploader.uploadImage`；括号配对用 `closeBrackets()`。工具栏与 hooks 通过 `CodeMirrorEditorHandle` 命令式 API（insertAtCursor / wrapSelection / getSelectionText）与编辑器交互，签名与旧 textarea 版一致。旧 `useEditorKeyboard.ts` / `AiGhostOverlay.tsx` 已删除——原 BLOCK_TRIGGER 正则第二组是非捕获组 `(?:...)`，`m[2]` 恒为 undefined，Enter 会插入 "undefined " 文本，即用户反馈的「编辑乱码」来源，已随重写消除
- **i18n（web）**：`packages/web/src/i18n/`——i18next + react-i18next 单例（`i18n/index.ts`，单一 `translation` namespace、默认 `keySeparator` 嵌套解析）。语言包按域拆 JSON（`zh-CN/{common,settings,doc,routes,graph,aichat,chrome,panels,editor,util}.json`），`zh-CN/index.ts` 深合并；`locales.ts` 的 `SUPPORTED_LOCALES` 是唯一语言注册表（加语言 = 加包 + 注册 + 同步 `index.html` 内联防闪烁脚本的 `SUPPORTED_CODES`）。组件内用 `useTranslation()` 的 `t()`；**非 React 模块（hooks/lib/cm 扩展/模块级辅助函数）用 `i18next.t()`**（`import i18next from '<rel>/i18n'`）。语言偏好：`hooks/useLocale.ts`（模块级 store + useSyncExternalStore，同 useTheme 模式），`localStorage 'notefast.locale'` = `'system' | '<code>'`，切换即 `i18next.changeLanguage` + 同步 `<html lang>`；设置页「通用与外观」有 LanguagePicker（zh-CN + en + 跟随浏览器）。时间格式化 `lib/time.ts` 已本地化（`currentLocale()` 导出；相对时间走 `time.*` 包）。**约定**：加 `const { t }` 后同作用域不得再有同名 `t` 变量/参数（map 参数改名）；key 用点分嵌套、camelCase；`errorsToFields`（ai-settings/validation.ts）按英文结构 token（provider 名/字段名）匹配而非中文串；`scripts/check-i18n.ts` 校验所有 `t()/i18next.t()` key 都在 zh-CN 包内、且 en 覆盖 zh-CN 全部 key（`bun --filter @notefast/web check:i18n`，支持单文件参数）。**服务端错误本地化**：服务端大多数错误响应已带 `error` code 字段（`not_found`/`bad_request`/`not_configured`/`ai_exclude_share_needs_confirm` 等 26 个），`useAPI.ts` 的 `ApiError` 在**语言非 zh-CN**时按 code 查 `errors.*` 包替换 message（`err.code` 为稳定判据，不要再用 message 子串判断），未知 code / 中文 UI 回退服务端富消息；**AI 助手语言跟随 UI（产品决策已定）**：web `fetchWithAuth` 对所有请求带 `Accept-Language` 头，服务端 `ai/locale.ts` 的 `resolveAiLang` 解析为 zh/en，chat 系统提示/上下文/工具描述（`ai/prompt.ts` + `ai/chat.ts`）、skills（`ai/skills.ts` 的 `listSkills(lang)`）、标题生成（core `suggestTitle(provider, content, lang)`）均按语言本地化；MCP 工具为外部 AI 客户端默认 zh（agent 可自行引导）；AI 写作辅助（core `write.ts`）保持跟随内容语言，未按 UI 本地化
- **原生客户端内嵌基建（engine 产物 + bootstrap）**：客户端 = 版本快照（bundle 某版本 engine 产物，启动经 `/api/v1/version` 做最低版本校验），业务零重写。`scripts/build-engine.ts`（`bun run build:engine`）产出 `packages/server/dist-engine/`：`bun build src/native/bootstrap.ts --compile` 单文件可执行 + `native/vec0.{dylib,dll,so}`（**编译单文件不内嵌可用 dylib，必须旁置并经 `SQLITE_VEC_PATH`**）+ macOS `libsqlite3.dylib`（brew，`SQLITE_LIBRARY_PATH`）+ `web-dist/`（`WEB_DIST`）+ `VERSION`，打成 `notefast-engine-<version>-<platform>.tar.gz`（`bun --compile` 只产宿主平台，CI 各平台 runner 分别跑）。**内嵌引导 `src/native/bootstrap.ts`**：CLI 参数 `--data-dir` / `--port 0` / `--assets-dir`，只监听 127.0.0.1 + `trustedLocal`（回环免鉴权），**stdout 是机器握手通道**——常规日志（console.log/info）重定向 stderr，启动成功后写一行 `NF_READY <json>`（port/version/notebookId/apiPath/mcpPath），客户端按 NF_READY 前缀扫描容错；优雅停机复用 index.ts 的 SIGTERM drain 语义。**两个编译产物陷阱**：① 定位资源必须用 `dirname(process.execPath)`（编译单文件里 `process.argv[1]`/`import.meta.dir` 解析到 `/$bunfs/root/` 虚拟路径，不可磁盘定位）；② `--define` 注入 `process.env.*` 不生效，版本经 VERSION 文件注入 APP_VERSION。`import.meta.main` 守卫避免被 import 误启动（parseNativeArgs/injectEngineAssets 有单测）
- **契约稳定守则（客户端安全依赖 REST 的前提）**：`/api/v1` REST **只做加法**——删端点/改响应形状须 bump 版本或双版本过渡；原生壳层只消费稳定子集（docs/blocks/search/sync protocol），不碰实验性端点；客户端 pin 最低 engine 版本，启动握手（`/api/v1/version`）不满足即提示更新客户端。Web 是同仓同版本演进的参考实现，是契约稳定性的活体守卫
- **Web 原生壳适配**：壳层（内嵌 WKWebView / Tauri）以 `?native=1`（或 `macos|tauri|windows|linux`）加载入口 URL → `index.html` 内联防闪烁脚本给 `<html>` 加 `native-shell` class + `data-shell` 属性；CSS 下 `[data-drag-region]` 启用 `-webkit-app-region: drag`、可交互子元素（button/a/input/textarea/select/[contenteditable]）自动 `no-drag`（Layout 顶栏已标注）；`API_BASE` 为相对路径 `/api/v1`，同源内嵌天然可用；免鉴权模式（未配置 AUTH_PASSWORD）下 `auth/mode` 返回 passwordRequired=false，Web 不弹登录（App.tsx 的 showAuthPrompt）
- **原生客户端工程布局（clients/）**：按平台族分目录（非 Bun workspace，`bun --filter '*'` 不扫）——`clients/apple/` = Apple 全平台 Swift 包（macOS 现役 + iOS 未来同包多 target），`clients/tauri/` = Tauri 壳（当前仅 Windows 构建，Linux 后续同一工程）。**`clients/apple/` 为 SPM 包**：`Sources/NoteFast` 共享库（NoteFastClient / Models / EngineProcess）+ `Sources/NoteFastApp` macOS 可执行 target（SwiftUI + WKWebView），`EngineProcess` 用 `#if os(macOS)` 隔离（iOS 禁派生进程）。`scripts/assemble-app.sh`（`clients/apple/scripts/`）组装 `dist/NoteFast.app`：`bun run build:engine` → `swift build -c release` → bundle（engine 产物注入 `Contents/Resources/engine/`）→ ad-hoc 签名（**engine 带 Bun JIT entitlements**：allow-jit 等，见 `Resources/notefast-server.entitlements`，意味着不能上 Mac App Store，走 Developer ID）→ `codesign --verify`。dev 模式（`swift run`）用 `NOTEFAST_ENGINE_DIR` 指向 `packages/server/dist-engine`；App 数据目录 `~/Library/Application Support/NoteFast/`。**退出链路**：App 发 SIGTERM → engine bootstrap drain（SSE 长连接会让退出拖到 ~10s 强退兜底，属预期）
- Web 阅读器样式与交互，替代原裸 textarea：底层始终是 Markdown 源码（零转换、无 round-trip 风险），装饰层做混合渲染（Typora-lite）。**排版体系与阅读态一致**（对齐 Obsidian 做法：编辑态复用阅读排版）：正文 16px `var(--font-sans)` / 行高 1.75，标题 = BlockRenderer 的 28/24/20px（1.75/1.5/1.25em），`var(--font-mono)` 只用于行内代码与代码块（0.85em + 淡底色），标记符压暗；图片与表格 widget 预览。**高亮样式两个坑**：① `editorHighlight` 必须定义泛型 `t.heading` 基准规则——`defaultHighlightStyle`（fallback）给泛型 heading 加了 bold+underline，而 lezer 给「表格表头行」打的正是泛型 heading（`TableHeader/...: tags.heading`），不定基准就会被 fallback 命中；② **lezer 会把「ATX 标题后无空行直接跟的表格」误解析为 SetextHeading2**（表头行+分隔行=文字+下划线），该表格在语法树里不是 Table——源码态表头会套用 heading2 样式（仅观感问题，阅读态 core 解析与 tablePreview 的正则扫描都不受影响）；调试编辑器语法树可用控制台 `__cmView`（CodeMirrorEditor 挂载时暴露在 window 上）。要点：**block 级 Decoration 必须由 StateField 提供**（ViewPlugin 只支持行内装饰）；widget 统一模式为「光标/选区在块内显示源码、块外渲染 widget，点击 widget 光标入块（mousedown 必须 `preventDefault + stopPropagation`，否则 CM 指针选区在 widget 销毁后把光标映射到块外，立即弹回 widget）」，实现见 `cm/imagePreview.ts` 与 `cm/tablePreview.ts`（表格块检测对齐 core/markdown.ts 的 isTableRow/isTableDelimiter，跳过 ``` 围栏内部防误判）；**CM 只渲染视口行**（.cm-line 仅视口内几十行，DOM 探测长文档须先滚动）；**改 cm/ 主题后 HMR 不会重建 EditorView，必须整页刷新才生效**（EditorView 在 useEffect 里只创建一次）；列表/引用续行与空项退出用 lang-markdown 自带 `insertNewlineContinueMarkdown`；` ``` ` + Enter 展开空代码块是自定义 keymap（`cm/keymap.ts`）；AI ghost text 走 `cm/ghostText.ts` 的 StateField + widget（Tab 接受 / Esc·输入取消）；图片粘贴/拖拽经 `EditorView.domEventHandlers` 转交 `useImageUploader.uploadImage`；括号配对用 `closeBrackets()`。工具栏与 hooks 通过 `CodeMirrorEditorHandle` 命令式 API（insertAtCursor / wrapSelection / getSelectionText）与编辑器交互，签名与旧 textarea 版一致。旧 `useEditorKeyboard.ts` / `AiGhostOverlay.tsx` 已删除——原 BLOCK_TRIGGER 正则第二组是非捕获组 `(?:...)`，`m[2]` 恒为 undefined，Enter 会插入 "undefined " 文本，即用户反馈的「编辑乱码」来源，已随重写消除
