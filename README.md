# NoteFast

**AI-first knowledge base — block-level API + MCP, AI writes and understands, humans read.**

NoteFast is a single-user, self-hosted knowledge base where Markdown is the surface and SQLite is the source of truth. Its core is a block tree model with full-text search, semantic retrieval, RAG chat, and AI-assisted writing — all exposed through REST and MCP.

## Quick Start

```bash
# Local development
bun install
bun --filter @notefast/server dev     # API + MCP on :3140
bun --filter @notefast/web dev        # Web UI on :5173

# Docker
docker compose up -d
```

Set a password for the Web UI and an API token for MCP access:

```bash
export AUTH_PASSWORD=your-password
export API_TOKEN=nf_your-secret-token
```

Optionally configure an AI provider to unlock search, chat, and writing:

```bash
export AI_PROVIDER=openai         # or: deepseek, siliconflow, ollama, etc.
export AI_API_KEY=sk-...
export EMBEDDING_PROVIDER=openai
export EMBEDDING_API_KEY=sk-...
```

AI settings can also be managed at runtime through the Web UI (`/settings`).

## Architecture

```
notefast/
├── packages/
│   ├── core/          # Shared types, block model, markdown↔block, AI config
│   ├── server/        # REST API (Hono), MCP Server, AI engine
│   └── web/           # React reading/writing UI
```

### Data Model

Everything is a **block** — a tree node with type and inline Markdown content:

```
document
├── heading "Architecture"
├── paragraph "NoteFast uses a block tree model..."
├── code "const x = 1"
└── list
    ├── list_item "Point one"
    └── list_item "Point two"
```

Blocks are the atomic unit. No raw file manipulation — all operations go through the block API.

### Storage

- **SQLite** single-file database in `data/` — schema migrations, FTS5 search, block tree CRUD
- **sqlite-vec** extension for vector search (production) with JSON fallback
- **Content-addressed media** in `data/media/<sha256>` — deduplicated images, stable `asset:<sha256>` references in Markdown
- **AI configuration** persists to `data/ai.config.json` with masked API keys in public views

## AI Capabilities

All AI features require an LLM provider (OpenAI-compatible API). 18 presets available: OpenAI, DeepSeek, Gemini, Ollama, SiliconFlow, etc.

| Capability | What it does |
|---|---|
| **Hybrid Search** | FTS5 + semantic embedding with RRF fusion, optional reranker |
| **RAG Chat** | Conversational AI with note citations, agent loop, tool calling |
| **AI Writing** | Ctrl+Enter inline continuation, refine, translate, summarise |
| **AutoLink** | After each write, the LLM extracts key concepts; high-confidence semantic matches automatically create inter-note links (`ref_type=ai_auto`) — no manual review |
| **Web Search** | Optional Brave Search integration for external knowledge |
| **Title/Suggest** | AI-generated document titles and summaries |
| **MCP Server** | Full read/write/search/chat tools for external AI agents |

## MCP Integration

External AI agents (Claude Desktop, Cursor, etc.) connect to NoteFast via MCP:

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

Available tools: `search`, `get_doc`, `get_block`, `create_doc`, `create_block`, `update_block`, `semantic_search`, `chat`, `list_docs`, `set_doc_tags`, `autolink_run`, and more.

## Capture

Send web selections, page links, or any external content into the inbox via a browser bookmarklet, iOS Shortcuts, or plain HTTP — deduplicated by source URL. Setup guide: [docs/capture.md](docs/capture.md).

## Keyboard Shortcuts

| Key | Action |
|---|---|
| ⌘K | Command palette |
| ⌘J | AI chat panel |
| ⌘Enter | AI continue writing |
| ⌘N | New document |
| ⌘S | Save (in editor) |
| ⌘P | Preview / Edit (in editor) |
| ⌘B / I / E | Bold / Italic / Inline code |
| ⌘⇧K | Insert link |

## Environment Variables

| Variable | Description |
|---|---|
| `AUTH_PASSWORD` | Web UI login password |
| `API_TOKEN` | API / MCP Bearer token |
| `PORT` | Server port (default 3140) |
| `DATA_DIR` | SQLite + media storage path |
| `AI_PROVIDER` | LLM provider preset ID |
| `AI_API_KEY` | LLM API key |
| `EMBEDDING_PROVIDER` | Embedding provider preset ID |
| `EMBEDDING_API_KEY` | Embedding API key |
| `CORS_ORIGINS` | Comma-separated allowed origins for the Web UI (default `http://localhost:5173`); **must set for production**. A literal `*` entry allows any origin — **dangerous**: in unauthenticated mode (no auth variables set) any web page can read/write the entire knowledge base; never use `*` in production |

### ⚠️ Production Deployment

Before exposing NoteFast publicly (not just `127.0.0.1`), set:

- `AUTH_PASSWORD` — required for Web UI login
- `API_TOKEN` (or split `READ_TOKEN` + `WRITE_TOKEN`) — required for API / MCP access
- `CORS_ORIGINS` — comma-separated origin allowlist; the default `http://localhost:5173` is **insecure** for production, and `*` disables the allowlist entirely (only acceptable for local development)

Auth-mode behavior: if **any** auth variable is set, the server runs in authenticated mode and rejects unauthenticated requests. If **none** are set, it runs in unauthenticated dev mode (every request treated as admin) and prints a startup warning to stderr.

## Quality

```bash
bun lint        # oxlint, zero tolerance for correctness violations
bun run typecheck   # strict TypeScript across all packages
bun test        # 350+ tests across 33 suites
```

## License

MIT — see [LICENSE](./LICENSE).
