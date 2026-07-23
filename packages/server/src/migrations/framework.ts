import type { Database } from 'bun:sqlite'
import * as m001 from './001_initial'
import * as m003 from './003_properties_columns'

interface Migration {
  id: string
  description: string
  up: (db: Database) => void
  down?: (db: Database) => void
}

const MIGRATIONS: Migration[] = [m001, m003]

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
  return db.query(`
    SELECT m.id, m.description, s.applied_at
    FROM (
      SELECT '001_initial' AS id, 'Initial schema: notebooks, blocks, FTS, block_vectors, assets, autolink, triggers' AS description
      UNION ALL
      SELECT '003_properties_columns' AS id, 'Extract tags/status/ai_exclude from properties JSON into explicit columns' AS description
    ) m
    LEFT JOIN schema_migrations s ON m.id = s.id
    ORDER BY m.id
  `).all() as Array<{ id: string; description: string; applied_at: string | null }>
}
