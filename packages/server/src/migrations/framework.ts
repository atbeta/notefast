import type { Database } from 'bun:sqlite'
// 迁移 002、005 为废稿（已删除），编号保留为空洞。
// 新迁移按递增编号续接即可。
import * as m001 from './001_initial'
import * as m003 from './003_properties_columns'
import * as m004 from './004_entity_changes'
import * as m006 from './006_content_hash'
import * as m007 from './007_api_tokens'
import * as m008 from './008_soft_delete'
import * as m009 from './009_pinned_views'

interface Migration {
  id: string
  description: string
  up: (db: Database) => void
  down?: (db: Database) => void
}

const MIGRATIONS: Migration[] = [m001, m003, m004, m006, m007, m008, m009]

export function runMigrations(db: Database): { applied: string[]; skipped: string[] } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

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
