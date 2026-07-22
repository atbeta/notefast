import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CURRENT_SCHEMA_VERSION } from '@notefast/core'
import { configureSqliteForExtensions } from './sqliteVec'

let db: Database
let dbPath = ''

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
  embedding_model TEXT,
  content_hash TEXT,
  index_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_block_vectors_dim ON block_vectors(dim);

CREATE TABLE IF NOT EXISTS vector_store_state (
  id                 TEXT PRIMARY KEY CHECK (id = 'default'),
  active_backend     TEXT NOT NULL DEFAULT 'json',
  status             TEXT NOT NULL DEFAULT 'stale',
  model_fingerprint  TEXT,
  dimension          INTEGER,
  active_generation  TEXT,
  staging_generation TEXT,
  indexed_count      INTEGER NOT NULL DEFAULT 0,
  error              TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO vector_store_state (id) VALUES ('default');

CREATE TABLE IF NOT EXISTS vector_generations (
  id                TEXT PRIMARY KEY,
  table_name        TEXT NOT NULL UNIQUE,
  model_fingerprint TEXT NOT NULL,
  dimension         INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'staging',
  indexed_count     INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vector_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  generation   TEXT NOT NULL,
  block_id     TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  notebook_id  TEXT NOT NULL,
  root_id      TEXT NOT NULL,
  block_updated_at TEXT NOT NULL,
  UNIQUE (generation, block_id),
  FOREIGN KEY (generation) REFERENCES vector_generations(id) ON DELETE CASCADE,
  FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_vector_entries_generation ON vector_entries(generation);
CREATE INDEX IF NOT EXISTS idx_vector_entries_block ON vector_entries(block_id);

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

-- ───────────────────── Assets（图片主数据）─────────────────────
-- id = 内容 sha256（内容寻址，天然去重）；文件本体在 data/media/<id>，库内只存元数据
CREATE TABLE IF NOT EXISTS assets (
  id          TEXT PRIMARY KEY,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

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
  configureSqliteForExtensions()
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true })
  }

  dbPath = join(dataDir, 'notefast.db')
  db = new Database(dbPath)
  db.exec('PRAGMA journal_mode=WAL')
  // WAL + synchronous=NORMAL：崩溃时最多丢失少量 WAL 帧，换取写入性能。
  // 完整灾备由应用内 VACUUM INTO 快照负责，不再依赖 Litestream。
  db.exec('PRAGMA synchronous=NORMAL')
  db.exec('PRAGMA foreign_keys=ON')

  db.exec(SCHEMA_SQL)
  migrateVectorSchema(db)
  applySchemaMigrations(db)

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

function migrateVectorSchema(database: Database): void {
  const columns = database.query('PRAGMA table_info(block_vectors)').all() as Array<{ name: string }>
  const names = new Set(columns.map((column) => column.name))
  const additions = [
    ['embedding_model', 'TEXT'],
    ['content_hash', 'TEXT'],
    ['index_version', 'INTEGER NOT NULL DEFAULT 1'],
    ['updated_at', "TEXT NOT NULL DEFAULT ''"],
  ] as const

  for (const [name, type] of additions) {
    if (!names.has(name)) {
      database.exec(`ALTER TABLE block_vectors ADD COLUMN ${name} ${type}`)
    }
  }
  database.exec("UPDATE block_vectors SET updated_at = created_at WHERE updated_at = ''")
}

/**
 * 顺序 migration：以 PRAGMA user_version 为权威。
 * v0 → v1：基线（当前 SCHEMA_SQL）
 * v1 → v2：已应用的 AutoLink 建议补齐 review_status=accepted（此前只改 action_status）
 */
function applySchemaMigrations(database: Database): void {
  const current = getSchemaVersion(database)
  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `数据库 schema 版本 ${current} 高于程序支持的 ${CURRENT_SCHEMA_VERSION}，请升级 NoteFast`,
    )
  }
  if (current < 1) {
    // 现有库与新建库均已通过 CREATE IF NOT EXISTS 达到 v1 结构
    database.exec(`PRAGMA user_version = 1`)
  }
  if (getSchemaVersion(database) < 2) {
    // 修复：applied 却仍停在 unreviewed，导致「未审阅」被已应用项占满、「已接受」永远为空
    database.exec(`
      UPDATE autolink_suggestions
      SET review_status = 'accepted',
          reviewed_at = COALESCE(reviewed_at, applied_at, datetime('now'))
      WHERE action_status = 'applied'
        AND review_status = 'unreviewed'
    `)
    database.exec(`PRAGMA user_version = 2`)
  }
}

export function getSchemaVersion(database: Database = getDb()): number {
  const row = database.query('PRAGMA user_version').get() as { user_version: number } | undefined
  return row?.user_version ?? 0
}

export function getDbPath(): string {
  if (!dbPath) throw new Error('数据库未初始化，请先调用 initDb()')
  return dbPath
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
