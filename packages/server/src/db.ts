import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CURRENT_SCHEMA_VERSION } from '@notefast/core'
import { configureSqliteForExtensions } from './sqliteVec'
import { runMigrations } from './migrations/framework'
import { safeLogInfo } from '@notefast/core'
import { auditSecretFilePermissions } from './services/secretAudit'

let db: Database
let dbPath = ''



export function initDb(dataDir: string): { db: Database; notebookId: string } {
  configureSqliteForExtensions()
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true })
    try { chmodSync(dataDir, 0o700) } catch { /* Windows 不支持 */ }
  }

  dbPath = join(dataDir, 'notefast.db')
  db = new Database(dbPath)
  db.exec('PRAGMA journal_mode=WAL')
  // WAL + synchronous=NORMAL：崩溃时最多丢失少量 WAL 帧，换取写入性能。
  // 完整灾备由应用内 VACUUM INTO 快照负责，不再依赖 Litestream。
  db.exec('PRAGMA synchronous=NORMAL')
  db.exec('PRAGMA foreign_keys=ON')

  runMigrations(db)
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
  auditSecretFilePermissions(dataDir)

  return { db, notebookId }
}

/**
 * 顺序 migration：以 PRAGMA user_version 为权威。
 * v0 → v1：基线（当前 SCHEMA_SQL）
 * v1 → v2：已应用的 AutoLink 建议补齐 review_status=accepted（此前只改 action_status）
 * v2 → v3：新增 asset_captions 表（图片理解的 caption 缓存）
 * v3 → v4：新增 shares 表（文档分享的公开 token）
 * v4 → v5：AutoLink 改为「高置信直接建链」——删除 autolink_suggestions 表，
 *           历史 ai_suggested 引用统一归为 ai_auto
 * v5 → v6：向量双 hash——block_vectors / vector_entries 新增 source_content_hash
 *          （= block.content 原文 hash，并发写保护用；content_hash 改为索引文本 hash），
 *          并按 blocks 现内容回填
 * v6 → v7：图谱实体层——新增 entities / entity_mentions 表（block→entity 提及边）
 * v7 → v8：登录审计——新增 auth_events 表（记录每次密码登录的时间/IP/UA）
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
  if (getSchemaVersion(database) < 3) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS asset_captions (
        id          TEXT PRIMARY KEY,
        caption     TEXT NOT NULL,
        model       TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
    database.exec(`PRAGMA user_version = 3`)
  }
  if (getSchemaVersion(database) < 4) {
    // 分享：doc_id → 公开 token。独立表而非 blocks.properties：
    // 开关分享不触发 updated_at / hooks / 索引 / change feed。
    // expires_at NULL = 永不过期（Notion 同款默认）。
    database.exec(`
      CREATE TABLE IF NOT EXISTS shares (
        doc_id     TEXT PRIMARY KEY,
        token      TEXT NOT NULL UNIQUE,
        expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(token);
    `)
    database.exec(`PRAGMA user_version = 4`)
  }
  if (getSchemaVersion(database) < 5) {
    // AutoLink 三态审核模型下线：建议表删除（历史建议不落新库），
    // 已应用的 ai_suggested 引用统一归为 ai_auto（语义等同「AI 建的链」）。
    database.exec(`DROP TABLE IF EXISTS autolink_suggestions`)
    database.exec(`UPDATE block_refs SET ref_type = 'ai_auto' WHERE ref_type = 'ai_suggested'`)
    database.exec(`PRAGMA user_version = 5`)
  }
  if (getSchemaVersion(database) < 6) {
    // 向量双 hash：content_hash 语义从「正文 hash」改为「索引文本 hash」，
    // 新增 source_content_hash 承载正文 hash（upsertToGeneration 并发校验锚）。
    // 不 bump VECTOR_INDEX_VERSION：旧向量靠 content_hash 不匹配自然过期。
    database.exec(`ALTER TABLE block_vectors ADD COLUMN source_content_hash TEXT`)
    database.exec(`ALTER TABLE vector_entries ADD COLUMN source_content_hash TEXT`)
    // 回填：按 blocks 现内容计算原文 hash（vision 默认关时与旧 content_hash 一致；
    // 与 ai/vectorStore.contentHash 同一算法，这里内联避免 db ↔ vectorStore 循环依赖）
    const hash = (s: string) => createHash('sha256').update(s).digest('hex')
    const backfill = (table: string) => {
      const rows = database
        .query(
          `SELECT v.rowid AS rid, b.content AS content
           FROM ${table} v JOIN blocks b ON b.id = v.block_id
           WHERE v.source_content_hash IS NULL`,
        )
        .all() as Array<{ rid: number; content: string }>
      const update = database.query(
        `UPDATE ${table} SET source_content_hash = ? WHERE rowid = ?`,
      )
      for (const row of rows) update.run(hash(row.content ?? ''), row.rid)
    }
    backfill('block_vectors')
    backfill('vector_entries')
    database.exec(`PRAGMA user_version = 6`)
  }
  if (getSchemaVersion(database) < 7) {
    // 图谱数据层第二类边：entity_mentions（block→entity 提及）。
    // 与 block_refs（block↔block）并列；一次 LLM 抽取同时喂建链与实体登记两条线。
    // 归并策略：规范化名精确匹配（idx_entities_name UNIQUE），不做 embedding 消歧。
    // mention_count 为冗余计数（列表排序/归零清理）；软删除不走 FK，由 store 层显式级联。
    database.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        display       TEXT NOT NULL,
        kind          TEXT NOT NULL,
        mention_count INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

      CREATE TABLE IF NOT EXISTS entity_mentions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        block_id   TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
        surface    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(entity_id, block_id)
      );
      CREATE INDEX IF NOT EXISTS idx_entity_mentions_block ON entity_mentions(block_id);
    `)
    database.exec(`PRAGMA user_version = 7`)
  }
  if (getSchemaVersion(database) < 8) {
    // 登录审计：记录每次密码登录的时间/IP/UA，不涉及鉴权逻辑。
    database.exec(`
      CREATE TABLE IF NOT EXISTS auth_events (
        id          TEXT PRIMARY KEY,
        event_type  TEXT NOT NULL DEFAULT 'login',
        ip          TEXT,
        user_agent  TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_auth_events_created ON auth_events(created_at DESC);
    `)
    database.exec(`PRAGMA user_version = 8`)
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
  if (process.env.API_TOKEN) return

  // 未显式配置任何鉴权时保持免鉴权（本地开发默认）：不生成也不加载 api.key。
  // 自动生成的 key 不应单方面把实例从免鉴权翻成强制鉴权——Web UI 没有密码可登录，
  // 只会全面 401。免鉴权状态由启动时的醒目告警（index.ts）提示。
  const authConfigured = ['AUTH_PASSWORD', 'READ_TOKEN', 'WRITE_TOKEN'].some(
    (k) => (process.env[k] || '').trim().length > 0,
  )
  if (!authConfigured) return

  const keyPath = join(dataDir, 'api.key')

  // 重启场景（鉴权已配置）：api.key 已存在但 env 未设置时加载进 env，
  // 保持 MCP/API 的 Bearer token 跨重启稳定，不重新生成。
  if (existsSync(keyPath)) {
    try {
      const key = readFileSync(keyPath, 'utf-8').trim()
      if (key) {
        process.env.API_TOKEN = key
        return
      }
    } catch { /* 读取失败则走重新生成 */ }
  }

  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const key = 'nf_' + Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  writeFileSync(keyPath, key + '\n', 'utf-8')
  process.env.API_TOKEN = key
  safeLogInfo('API Key 已生成', { key_path: keyPath, api_key: key })
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
