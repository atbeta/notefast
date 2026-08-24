# NoteFast

**An AI-native Markdown knowledge base — every note you write is automatically indexed, linked, and retrievable. Self-hosted, multi-platform, and your data stays in your hands.**

NoteFast automatically indexes every note — full-text and semantic — links related ideas together, and makes it all retrievable through hybrid search, RAG chat with citations, and an entity graph. It's a single-user, self-hosted system built on one SQLite file, with native clients for macOS and Windows. For AI agents, the full knowledge domain — block read/write, search, chat, entities, sharing — is exposed through a stable REST API and MCP server; instance administration (backup, sync, tokens, maintenance) stays REST-only.

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
