import type { Database } from 'bun:sqlite'
import * as m001 from './001_initial'
import * as m002 from './002_web_session_tokens'
import * as m003 from './003_block_revisions'
import * as m004 from './004_doc_snapshots'
import * as m005 from './005_entity_description'
import * as m006 from './006_entity_aliases'
import * as m007 from './007_vector_binary_embedding'
import * as m008 from './008_asset_remote_url'
import * as m009 from './009_asset_upload_error'
import * as m010 from './010_asset_upload_attempted_at'
import * as m011 from './011_client_errors'
import * as m012 from './012_fts_update_of_content'
import * as m013 from './013_block_refs_unique_pair'
import * as m014 from './014_sync_consume_guard'
import * as m015 from './015_doc_created_index'
import * as m016 from './016_content_hash_deprecated'
import * as m017 from './017_app_logs'
import * as m018 from './018_entity_index_state'
import * as m019 from './019_assets_filename'
import * as m020 from './020_fts_rowid_map'

interface Migration {
  id: string
  description: string
  up: (db: Database) => void
  down?: (db: Database) => void
}

/** 唯一基线迁移。历史 002-010 已合并到此。 */
const MIGRATIONS: Migration[] = [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m015, m016, m017, m018, m019, m020]

export function runMigrations(db: Database): { applied: string[]; skipped: string[] } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  /** 清理已合并到基线的历史条目（001-010），保留后续迁移记录不被误删 */
  const knownIds = new Set(MIGRATIONS.map((m) => m.id))
  const historicalDeleted = (db.query('SELECT id FROM schema_migrations').all() as Array<{ id: string }>)
    .filter((r) => !knownIds.has(r.id))
    .map((r) => r.id)
  for (const id of historicalDeleted) {
    db.query('DELETE FROM schema_migrations WHERE id = ?').run(id)
  }

  const applied: string[] = []
  const skipped: string[] = []

  for (const migration of MIGRATIONS) {
    const exists = db.query('SELECT 1 FROM schema_migrations WHERE id = ?').get(migration.id)
    if (exists) {
      skipped.push(migration.id)
      continue
    }

    db.transaction(() => {
      migration.up(db)
      db.query('INSERT INTO schema_migrations (id, description) VALUES (?, ?)')
        .run(migration.id, migration.description)
    })()

    applied.push(migration.id)
    console.log(`🗂  migration applied: ${migration.id} (${migration.description})`)
  }

  return { applied, skipped }
}

export function listMigrations(db: Database): Array<{ id: string; description: string; applied_at: string | null }> {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`)
  const applied = new Map(
    (db.query('SELECT id, applied_at FROM schema_migrations').all() as Array<{ id: string; applied_at: string }>)
      .map((r) => [r.id, r.applied_at] as const),
  )
  return MIGRATIONS.map((m) => ({
    id: m.id,
    description: m.description,
    applied_at: applied.get(m.id) ?? null,
  }))
}
