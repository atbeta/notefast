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
│   ├── core/                # 共享类型与数据模型
│   │   └── src/
│   │       ├── types.ts     # Block, Document, Notebook, Workspace 等类型
│   │       ├── model.ts     # Block 树操作（CRUD、移动、排序）
│   │       ├── markdown.ts  # Markdown ↔ Block 树互转
│   │       └── search.ts    # FTS5 查询构建
│   │
│   ├── server/              # REST API + MCP Server
│   │   └── src/
│   │       ├── index.ts     # 入口，Hono 应用创建
│   │       ├── db.ts        # SQLite 初始化、migrations
│   │       ├── api/         # REST 路由（blocks, docs, search, refs, import）
│   │       ├── mcp/         # MCP Tool 定义
│   │       └── middleware/  # 可选鉴权
│   │
│   └── web/                 # React Web 阅读器
│       └── src/
│           ├── App.tsx
│           ├── routes/      # 页面路由（home, notebook, doc）
│           ├── components/  # BlockRenderer, DocTree, SearchBar 等
│           └── hooks/       # useAPI 等
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
- 笔记组织优先 tag + 智能视图，不主推多笔记本 UI；底层保留单 Notebook 即可
- 文档默认对 AI 可见；「对 AI 隐藏」入口应低调（勿用锁图标或「对 AI 可见」易被读成需点击才可见）；已隐藏态再显式状态与恢复
- 暂不需要「默认 AI 可见性」全局设置；少数敏感笔记用手动 opt-out 即可

## Learned Workspace Facts

- 语义向量经 `VectorStore` 抽象；默认可为 JSON 后端，配置 embedding 后经索引重建切到 sqlite-vec；向量是可重建二级索引，SQLite 仍为权威数据
- `block_vectors` 需记录 `embedding_model` / `content_hash` / `index_version`；模型或版本变化标记 stale，旧向量不参与检索
- Docker 部署需显式打包 sqlite-vec 原生扩展（linux amd64/arm64 的 `vec0`），不能依赖完整 `node_modules`
- Markdown 归档（LocalFS/S3/WebDAV）是单向内容副本，会丢失 ID/引用/标签等元数据；完整灾备用应用内 SQLite→S3 快照（设置页 / `docs/backup.md`）
- Markdown 归档远端文件名为 `<slug>--<docId>.md`，并由 `notefast-archive.manifest.json` 跟踪与清理陈旧文件；S3 与 WebDAV 同步适配器同时只能启用一个，且仅为单向 push
- 文档 markdown 导出在根写入 `# {title}` 为有意设计；编辑器加载需 strip 与标题同文的首 H1（含子块时提升其子块）
- 数据库备份配置在 `data/backup.config.json`；恢复须停服后跑 `bun --filter @notefast/server backup:restore`
- 旧 Litestream Compose profile 已移除（`-exec true` 会导致复制进程退出）
- 文档组织：tag 多选默认 AND（同时包含），`tag_match=any` 为包含任一；智能视图为内置预设 + URL 参数（无自定义命名视图表）
- `properties.ai_exclude: true` 软隔离：不进向量/RAG/AutoLink/MCP 发现与按 ID 读取；人类 Web 列表/编辑/Cmd+K 仍可用；备份与 Markdown 归档仍含全文
