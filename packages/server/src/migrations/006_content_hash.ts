import type { Database } from 'bun:sqlite'

export const id = '006_content_hash'
export const description = 'Add content_hash column to blocks for content dedup/sync'

export function up(db: Database): void {
  db.exec(`ALTER TABLE blocks ADD COLUMN content_hash TEXT`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_blocks_content_hash ON blocks(content_hash)`)
}

export function down(db: Database): void {
  db.exec(`DROP INDEX IF EXISTS idx_blocks_content_hash`)
}
