import type { Database } from 'bun:sqlite'

export const id = '006_entity_aliases'
export const description = 'entity alias dictionary for merge routing (E5)'

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_aliases (
      alias      TEXT PRIMARY KEY,
      entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
}
