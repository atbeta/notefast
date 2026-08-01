import type { Database } from 'bun:sqlite'

export const id = '003_block_revisions'
export const description = 'block content revision history for undo/rollback'

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS block_revisions (
      block_id    TEXT NOT NULL,
      rev         INTEGER NOT NULL,
      content     TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      actor       TEXT NOT NULL DEFAULT 'user',
      created_at  TEXT NOT NULL,
      PRIMARY KEY (block_id, rev)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_block_revisions_block ON block_revisions(block_id, rev DESC)`)
}
