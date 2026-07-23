import type { Database } from 'bun:sqlite'

export const id = '009_pinned_views'
export const description = 'Server-side pinned views table'

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE pinned_views (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      query TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
}

export function down(db: Database): void {
  db.exec(`DROP TABLE IF EXISTS pinned_views`)
}
