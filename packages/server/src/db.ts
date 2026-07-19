import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

let db: Database

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notebooks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  icon        TEXT DEFAULT '',
  sort        INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS blocks (
  id          TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  parent_id   TEXT,
  root_id     TEXT NOT NULL,
  type        TEXT NOT NULL,
  content     TEXT DEFAULT '',
  properties  TEXT DEFAULT '{}',
  sort        INTEGER DEFAULT 0,
  level       INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (parent_id) REFERENCES blocks(id) ON DELETE CASCADE,
  FOREIGN KEY (root_id) REFERENCES blocks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_blocks_parent ON blocks(parent_id);
CREATE INDEX IF NOT EXISTS idx_blocks_root ON blocks(root_id);
CREATE INDEX IF NOT EXISTS idx_blocks_notebook ON blocks(notebook_id);
CREATE INDEX IF NOT EXISTS idx_blocks_type ON blocks(type);

CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
  id UNINDEXED,
  content,
  tokenize='unicode61'
);

CREATE TABLE IF NOT EXISTS block_vectors (
  block_id  TEXT PRIMARY KEY,
  embedding TEXT NOT NULL,
  dim       INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_block_vectors_dim ON block_vectors(dim);

CREATE TABLE IF NOT EXISTS block_refs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  ref_type    TEXT DEFAULT 'link',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (source_id) REFERENCES blocks(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES blocks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_refs_source ON block_refs(source_id);
CREATE INDEX IF NOT EXISTS idx_refs_target ON block_refs(target_id);

-- ───────────────────── AutoLink suggestions (Tier 1) ─────────────────────
-- 双轴状态：
--   action_status: suggested | applied | reverted | failed | superseded
--   review_status: unreviewed | accepted | dismissed
-- created_ref_id 精确锚定 block_refs 行，撤销时按 id 删除（不依赖 source/target 对）
CREATE TABLE IF NOT EXISTS autolink_suggestions (
  id                    TEXT PRIMARY KEY,
  source_block_id       TEXT NOT NULL,
  source_content_hash   TEXT NOT NULL,
  source_updated_at     TEXT NOT NULL,
  notebook_id           TEXT NOT NULL,
  anchor                TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  candidates            TEXT NOT NULL,
  action_status         TEXT NOT NULL DEFAULT 'suggested',
  review_status         TEXT NOT NULL DEFAULT 'unreviewed',
  created_ref_id        INTEGER,
  applied_target_id     TEXT,
  score_kind            TEXT,
  model                 TEXT,
  error                 TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at            TEXT,
  reviewed_at           TEXT,
  -- 不对 source_block_id 加 FK CASCADE：suggestion 是审计记录，源块被删后建议仍应保留（inbox 历史可查）
  FOREIGN KEY (created_ref_id) REFERENCES block_refs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_autolink_review ON autolink_suggestions(review_status);
CREATE INDEX IF NOT EXISTS idx_autolink_action ON autolink_suggestions(action_status);
CREATE INDEX IF NOT EXISTS idx_autolink_source ON autolink_suggestions(source_block_id);
CREATE INDEX IF NOT EXISTS idx_autolink_hash   ON autolink_suggestions(source_block_id, source_content_hash);

-- FTS 自动同步触发器
CREATE TRIGGER IF NOT EXISTS blocks_fts_insert AFTER INSERT ON blocks
BEGIN
  INSERT INTO blocks_fts (id, content) VALUES (NEW.id, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS blocks_fts_update AFTER UPDATE ON blocks
BEGIN
  UPDATE blocks_fts SET content = NEW.content WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS blocks_fts_delete AFTER DELETE ON blocks
BEGIN
  DELETE FROM blocks_fts WHERE id = OLD.id;
END;
`

export function initDb(dataDir: string): { db: Database; notebookId: string } {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true })
  }

  const dbPath = join(dataDir, 'notefast.db')
  db = new Database(dbPath)
  db.exec('PRAGMA journal_mode=WAL')
  // WAL + synchronous=NORMAL 是 Litestream 推荐的配置：
  // 崩溃时最多丢失 1 帧 WAL（通常 <100ms 的写入），换取显著的写入性能与 SSD 寿命。
  db.exec('PRAGMA synchronous=NORMAL')
  db.exec('PRAGMA foreign_keys=ON')

  db.exec(SCHEMA_SQL)

  const ftsCount = (db.query('SELECT count(*) as c FROM blocks_fts').get() as { c: number })?.c ?? 0
  const blocksCount = (db.query('SELECT count(*) as c FROM blocks').get() as { c: number })?.c ?? 0
  if (ftsCount < blocksCount) {
    db.exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")
  }

  let notebookId = getDefaultNotebookId(db)
  if (!notebookId) {
    notebookId = createDefaultNotebook(db)
  }

  initApiKey(dataDir)

  return { db, notebookId }
}

function initApiKey(dataDir: string): void {
  const keyPath = join(dataDir, 'api.key')
  if (existsSync(keyPath)) return
  if (process.env.API_TOKEN) return

  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const key = 'nf_' + Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  writeFileSync(keyPath, key + '\n', 'utf-8')
  process.env.API_TOKEN = key
  console.log('')
  console.log('  🔑 API Key: ' + key)
  console.log('     保存位置: ' + keyPath)
  console.log('     用于 MCP/API 鉴权: Authorization: Bearer ' + key)
  console.log('')
}

export function getApiKey(): string {
  const envKey = process.env.API_TOKEN?.trim()
  if (envKey) return envKey

  const dataDir = process.env.DATA_DIR || './data'
  const keyPath = join(dataDir, 'api.key')
  try {
    const key = readFileSync(keyPath, 'utf-8').trim()
    if (key) return key
  } catch { /* ignore */ }
  return ''
}

export function getDb(): Database {
  if (!db) {
    throw new Error('数据库未初始化，请先调用 initDb()')
  }
  return db
}

export function closeDb(): void {
  if (db) {
    db.close()
  }
}

function getDefaultNotebookId(database: Database): string | null {
  const row = database.query('SELECT id FROM notebooks LIMIT 1').get() as { id: string } | undefined
  return row?.id ?? null
}

function createDefaultNotebook(database: Database): string {
  const id = crypto.randomUUID()
  database
    .query('INSERT INTO notebooks (id, name) VALUES (?, ?)')
    .run(id, '我的笔记')
  return id
}
