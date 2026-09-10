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

### Docker: a folder is the deployment

A vault is the only supported shape: your Markdown folder is the source of truth and SQLite is a rebuildable index (see [docs/vault-migration.md](docs/vault-migration.md)). `docker-compose.yml` is already set up that way — create the folder first, then start it:

```bash
mkdir -p notes            # create it yourself: Docker would create it owned by root
docker compose up -d
```

`./notes` is mounted at `/vault` and `VAULT_PATH=/vault` points the engine at it. Point it elsewhere by editing the volume line, e.g. `- ~/Notes:/vault`.

If you run an instance **without** a folder (database mode), the engine still works but the web UI shows a setup notice instead of the app: it explains how to move pre-0.90 notes over (with an export button) or how to attach a folder. To add vault mode to your own compose file:

```yaml
    environment:
      - VAULT_PATH=/vault
      - NOTEFAST_APP_SUPPORT_DIR=/app/data   # index parent; see below
    volumes:
      - ~/Notes:/vault      # read-write: NoteFast writes edits back to your files
```

`DATA_DIR` (and `NOTEFAST_APP_SUPPORT_DIR`) is the **index parent** in vault mode: the index lands in `<parent>/<sha256(vault path) 前12位>`, so one vault gets one index and switching vaults never reuses the old one. In db mode `DATA_DIR` is still the index itself. Upgrading from 0.90.0 with an index directly in `/app/data` keeps working: the engine detects the old layout, reuses it and prints a warning.

| Variable | Description |
|---|---|
| `VAULT_PATH` | Vault root inside the container (`/vault` by convention); enables vault mode |
| `NOTEFAST_APP_SUPPORT_DIR` | Index parent in vault mode (defaults to `DATA_DIR`, then the platform app-support dir) |
| `VAULT_USE_POLLING` | Force a watcher backend: `true`/`1` = poll, `false`/`0` = native events; unset = detected at startup |
| `VAULT_POLL_INTERVAL_MS` | Polling interval in ms (default 1000) |
| `VAULT_WATCH` | `false` disables watching (`POST /api/v1/vault/rebuild` still works) |
| `VAULT_WRITEBACK` | `false` keeps edits in the index only (no write-back to files) |
| `VAULT_RECONCILE_MINUTES` | Light periodic reconcile interval in minutes (default 10, `0` disables) — catches edits missed by the watcher |

**The watcher backend is detected at startup.** A bind mount shared from the host into the container does not reliably deliver host-side changes (Docker Desktop's gRPC-FUSE / VirtioFS, OrbStack's VirtioFS, NAS mounts), and macOS paths behind a symlink (`/tmp` → `/private/tmp`) do not deliver FSEvents reliably either. Instead of making you remember which environment needs polling, the engine checks the filesystem type of the vault root — virtual or network filesystems get polling outright — and otherwise writes a hidden probe file and watches it. The effective mode is reported:

```bash
curl -s http://localhost:3140/api/v1/vault/status | jq '{enabled, watcher_mode, polling_auto, use_polling, watcher_active, files}'
```

`watcher_mode: "polling"` with `polling_auto: true` means polling was chosen automatically, and `files` changes shortly after you add or edit a Markdown file. Force a backend with `VAULT_USE_POLLING=true` (polling) or `VAULT_USE_POLLING=false` (native events); when the variable is unset the probe decides.

### Migrating an existing notebook to vault mode

vault mode does not convert a `kind='db'` notebook in place. Export it to Markdown, tidy the folder, and start a new instance against it — the old instance stays untouched as a fallback. Full step-by-step guide with measured timings: [docs/vault-migration.md](docs/vault-migration.md).

```bash
curl -H "Authorization: Bearer $API_TOKEN" -o notefast-archive.zip \
  http://localhost:3140/api/v1/export/archive
ditto -x -k notefast-archive.zip ~/Notes     # macOS; GNU unzip: unzip -O UTF-8 ...
cd ~/Notes && rm -f notefast-archive.manifest.json && mv media assets
find . -name '*.md' -exec sed -i '' 's|](\.\./media/|](../assets/|g' {} +
find . -name '*--*.md' -print0 | while IFS= read -r -d '' f; do
  mv "$f" "$(dirname "$f")/$(basename "$f" | sed 's/--[0-9a-f]\{12\}\.md$/.md/')"
done
VAULT_PATH=~/Notes DATA_DIR=./data-vault PORT=3141 bun --filter @notefast/server dev
```

What carries over: body, tags, creation time, Obsidian block ids (`^abc123`), images, and `[[wikilinks]]` re-resolved by file name. What is rebuilt or lost: document/block ids, references, AutoLink, vectors, revision history, share links, and **the inbox / `ai_exclude` state** (the export does not write `notefast_status` / `notefast_ai_exclude`). Two gotchas the guide calls out: macOS `unzip` mangles UTF-8 file names (use `ditto`), and the exported slug differs from the original `# title`, so the duplicate H1 is kept unless you rename files to the H1.

### Syncing a vault between devices

vault mode syncs **the files themselves** through an object store you own (S3, WebDAV or a local folder) — the same storage connections used by backup and archiving. The SQLite index is never synced: it is rebuilt from the files, so there is exactly one authority. Design and measurements: [docs/rfcs/0004-vault-file-sync.md](docs/rfcs/0004-vault-file-sync.md).

```bash
# Settings → Vault → File sync: pick a storage connection (or a local folder), enable, save
curl -X PUT http://localhost:3140/api/v1/vault/sync/config \
  -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"enabled":true,"locationId":"my-s3","prefix":"notefast-vault/","intervalSeconds":60}'
curl -X POST http://localhost:3140/api/v1/vault/sync/push   # 立即推送
curl -X POST http://localhost:3140/api/v1/vault/sync/pull   # 立即拉取
curl -s  http://localhost:3140/api/v1/vault/sync/status     # 状态 / 上次结果 / 冲突
```

How it behaves: content-addressed blobs deduplicate identical files; each device writes only its own manifest shard, so devices never race on one remote file; conflicts never silently merge — the newer version becomes the file and the older one is kept next to it as `<name>.notefast-conflict-<device>-<timestamp>.md`. Files land on disk and are ingested by the normal watcher, so search, links and AI follow automatically. **Do not run a second file-sync tool (iCloud, Dropbox, Syncthing) on the same folder** — that is the known double-sync failure mode; the vault panel warns about it.

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
