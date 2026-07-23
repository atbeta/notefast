import type { Database } from 'bun:sqlite'
import * as m001 from './001_initial'

interface Migration {
  id: string
  description: string
  up: (db: Database) => void
  down?: (db: Database) => void
}

/** 唯一基线迁移。历史 002-010 已合并到此。 */
const MIGRATIONS: Migration[] = [m001]

export function runMigrations(db: Database): { applied: string[]; skipped: string[] } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  db.exec(`DELETE FROM schema_migrations WHERE id != '001_initial'`)

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
