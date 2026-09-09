# NoteFast Next

> ⚠️ **Next 分支**：本分支是 NoteFast 的平行开发线，定位为"vault mode"——
> **用户 vault 文件夹是权威，SQLite 是派生索引，AI/RAG 跟随文件变化**。
>
> 与 `main` 分支（NoteFast v0.86.x）平行存在。`main` 继续走 SQLite-authoritative + shadow-markdown 路线，`next` 走 file-authoritative + vault mode 路线。
>
> 📄 详细 RFC：[`docs/rfcs/0001-vault-mode.md`](docs/rfcs/0001-vault-mode.md) · [`0002-block-identity.md`](docs/rfcs/0002-block-identity.md)

---

## 这是什么

NoteFast Next 把 NoteFast 从"AI 知识库"重新定位为"Obsidian 的 AI 引擎"：

- **用户拥有真 .md 文件**：放在 vault 文件夹下，被任何编辑器修改（Obsidian、VS Code、vim、iOS）
- **AI 能力不丢失**：FTS5 搜索、向量检索、AutoLink、实体图谱、RAG chat、MCP 全保留
- **跨工具稳定引用**：文件身份稳定（路径）、块身份稳定（指纹算法）、引用软解析（漂移降级）
- **零冲突**：AI 修改通过 atomic rename 写回文件，不持锁

## 状态

🚧 **v0.1.0-next.0 预发布草案**——架构定型，骨架代码 + PoC 已落地，**尚未实现完整的 vault ingest 流程**。

可以做的事情：
- ✅ 跑 chokidar PoC，验证文件变更能传到现有 import 端点
- ✅ 跑 `vaultFingerprint` 算法，对比微编辑/中编辑/大改的 ID 漂移率
- ✅ 读 RFC 0001 / 0002，理解设计决策

不能做的事情（要等后续 PR）：
- ❌ 完整 vault ingest（解析 → align → apply 到 SQLite）
- ❌ wiki-link 自动建链
- ❌ vault 模式的 web UI
- ❌ 老 SQLite notebook 迁移到 vault

## 跑 PoC

```bash
# 启动 NoteFast Next server（在 next 分支上）
bun --filter @notefast-next/server dev

# 在另一个终端跑独立 chokidar PoC
NF_TOKEN=<token> VAULT_PATH=./test-vault bun run tools/vault-poc/chokidar-demo.ts

# 编辑 vault 里的文件，观察 PoC 输出 + NoteFast UI 里的 Cmd+K 搜索结果
```

详见 [`tools/vault-poc/README.md`](tools/vault-poc/README.md)。

## 与 main 分支的关系

| 维度 | `main` (NoteFast v0.86.x) | `next` (NoteFast Next) |
|---|---|---|
| 数据权威 | SQLite | 用户 vault 文件夹 |
| Markdown 角色 | 导出格式 | 主格式 |
| 编辑器 | 内置 CodeMirror | 任意（Obsidian 优先） |
| 文件可见性 | shadow-markdown 单向投影（v0.86） | vault 双向跟随 |
| 包名 | `@notefast/{core,server,web}` | `@notefast-next/{core,server,web}` |
| 同步 | 应用内 S3/WebDAV | 文件系统层（iCloud/Syncthing/git） |

`next` 分支独立 semver；与 `main` 不互通 schema、不互通索引，但共享 git 历史（cherry-pick 老 bugfix 方便）。

## 路线图

- **v0.1.0-next.x**：vault adapter + chokidar watcher + ingest 流程（本期 PR）
- **v0.3.0-next.x**：web UI 只读 vault 视图
- **v0.5.0-next.x**：完整 vault 编辑器（CodeMirror + auto-save）
- **v1.0**：vault 是唯一模式，老用户迁移 CLI

详见 [`docs/rfcs/0001-vault-mode.md`](docs/rfcs/0001-vault-mode.md) §"迁移路径"。

---

## License

继承原 NoteFast 仓库的 LICENSE。


## Quick Start

### Download the app (easiest)

Grab the latest installer from [GitHub Releases](https://github.com/atbeta/notefast/releases):

- **macOS** — signed & notarized DMG; embeds the local server, no runtime dependencies
- **Windows** — Tauri-based installer (NSIS) **or** a [portable zip](#windows-portable-zip) for USB / no-install use

The app runs a local engine on `127.0.0.1` and stores everything under the per-user data directory. No account, no cloud required.

### Windows portable zip

If you prefer not to install (e.g., running from a USB stick or a read-only folder), grab `NoteFast-<version>-portable-windows.zip` from the release. Extract anywhere, run `notefast.exe`. Data lives in the same folder under `data/`, so the whole tree is your portable install — copy/move/backup by moving the folder. No auto-update; download a new zip when you want to upgrade.

How it works: the zip mirrors the NSIS install layout — `notefast.exe`, the embedded `engine/` directory, and an empty `notefast-portable` marker. The shell sees the marker and routes user data to `<exe>/data/` instead of `%APPDATA%\com.notefast.desktop\`. Same binary as the installer, two storage modes — selected at runtime by what the shell finds next to itself.

### Docker (self-hosted server)

```bash
docker compose up -d
```

Then open `http://localhost:3140`. Set `AUTH_PASSWORD` and `API_TOKEN` before exposing it to a network — see [Deployment & Security](#deployment--security).

### From source (development)

```bash
bun install
bun --filter @notefast/server dev     # API + MCP on :3140
bun --filter @notefast/web dev        # Web UI on :5173
```

## Why NoteFast

- **Your data, one file.** Everything lives in a single SQLite database under `data/` — no external database, no vendor lock-in. Vectors are a rebuildable secondary index, not a separate store.
- **AI is a first-class citizen.** Retrieval, chat, auto-linking, and writing assistance are built into the core and exposed via MCP — external agents (Claude Desktop, Cursor, …) get the same knowledge-domain capabilities as the built-in UI. AI calls made over MCP bill against your own configured provider key.
- **Real writing experience.** A CodeMirror-based hybrid editor (Typora-lite) with image/table/LaTeX previews, Mermaid rendering, ghost-text continuation, and selection-level AI rewrite.
- **Open by contract.** Capabilities land in the API/MCP layer first, UI second; portable Markdown export with frontmatter, and verified backup/restore paths.

## Features

**Writing & reading**
- Block-tree documents with inline Markdown; hybrid editor with live previews (images, tables, LaTeX via KaTeX, Mermaid diagrams)
- Tags with AND/OR filtering, smart views, inbox / archive / trash lifecycle
- Block-level reading surface: copy block links, ask AI about a passage
- Chinese & English UI (i18n), dark/light themes

**AI**
- Hybrid search: FTS5 + LIKE lexical, semantic embeddings, title, entity and graph-context channels fused with RRF, optional reranker
- RAG chat with citations and an agent loop (the AI can search, read, and suggest edits)
- AutoLink: after each write, high-confidence concept matches automatically create inter-note references; entity mentions power the knowledge graph
- AI writing: ghost-text continuation (Ctrl+J, Tab to accept), selection rewrite, title suggestion
- Bring your own provider: OpenAI-compatible chat/embedding/reranker slots with presets (OpenAI, DeepSeek, SiliconFlow, DashScope, Ollama, …), configured in Settings

**Knowledge graph**
- Automatic entity extraction (concepts / people / tools / docs) with a force-directed co-occurrence graph
- Entity dictionary for alias normalization and query expansion

**Sync, backup & capture**
- Multi-device sync over your own object storage (S3 / WebDAV) — peer model, no central server, automatic
- Disaster recovery: in-app SQLite→S3 snapshots with offline restore CLI; one-way Markdown archive (LocalFS / S3 / WebDAV) for portable copies — see [docs/backup.md](docs/backup.md)
- Capture: `POST /import/markdown` for web clippers / iOS shortcuts / file-open, with path+hash dedup — see [docs/capture.md](docs/capture.md)
- Public read-only share links per document (optional expiry)

**Desktop apps (macOS / Windows)**
- Embedded local engine with graceful lifecycle, crash recovery, and engine logs
- Menu-bar presence, system notifications, deep links (`notefast://doc/<id>`, `notefast://search?q=…`)
- Open-and-import for `.md` files, native back/forward navigation, lightweight update check

## MCP Integration

External AI agents connect to NoteFast over MCP:

```json
{
  "mcpServers": {
    "notefast": {
      "url": "http://localhost:3140/mcp",
      "headers": { "Authorization": "Bearer nf_your-secret-token" }
    }
  }
}
```

Tools cover the knowledge-domain surface: `notefast_search` / `notefast_semantic_search`, `notefast_get_doc`, `notefast_create_doc` / `notefast_update_block` / `notefast_delete_block` / `notefast_move_block`, `notefast_stage_markdown` + `notefast_create_doc_from_file` for large imports, `notefast_create_ref` / `notefast_delete_ref` for explicit linking, `notefast_share_doc`, `notefast_restore_block`, `notefast_chat`, and more. Read-only tokens (an api-token without the `write` scope, or `READ_TOKEN` in split mode) can call read tools only; write tools return a `forbidden` tool error.

## Keyboard Shortcuts

| Key | Action |
|---|---|
| ⌘K | Command palette / search |
| ⌘J | AI chat panel |
| ⌘N | New document |
| ⌘Enter | AI ghost-text continuation (Tab to accept, Esc to dismiss) |
| ⌘S / ⌘P | Save / toggle preview (in editor) |
| ⌘B / I / E | Bold / Italic / Inline code |
| ⌘⇧K | Insert link |
| ⌘[ / ⌘] | Back / forward (desktop app) |

## Deployment & Security

Before exposing NoteFast beyond `127.0.0.1`, set:

- `AUTH_PASSWORD` — Web UI login password
- `API_TOKEN` (or split `READ_TOKEN` + `WRITE_TOKEN`) — API / MCP Bearer token
- `CORS_ORIGINS` — origin allowlist for the Web UI; a literal `*` entry disables it and is **dangerous** without auth: any web page could read/write the entire knowledge base

Auth mode: if **any** auth variable is set, the server requires authentication; if **none** are set, it runs in unauthenticated local mode (with a startup warning).

Common environment variables:

| Variable | Description |
|---|---|
| `PORT` | Server port (default 3140) |
| `DATA_DIR` | SQLite + media storage path |
| `AUTH_PASSWORD` / `API_TOKEN` | Web password / API token (see above) |
| `READ_TOKEN` / `WRITE_TOKEN` | Optional split read/write tokens |
| `CORS_ORIGINS` | Comma-separated origin allowlist |

AI providers are configured at runtime in **Settings → AI** (three slots: chat / embedding / reranker).

## Development

```
notefast/
├── packages/
│   ├── core/          # Shared types, block model, markdown↔block, AI config
│   ├── server/        # REST API (Hono), MCP server, AI engine, sync & backup
│   └── web/           # React reading/writing UI
└── clients/
    ├── apple/         # macOS (SwiftUI + WKWebView, embedded engine)
    └── tauri/         # Windows (Tauri)
```

```bash
bun lint              # oxlint
bun run typecheck     # strict TypeScript
bun test              # 800+ tests
```

Contributor conventions and deep architectural notes live in [AGENTS.md](AGENTS.md).

## License

MIT — see [LICENSE](./LICENSE).
