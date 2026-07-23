import type { Database } from 'bun:sqlite'

export const id = '003_properties_columns'
export const description = 'Extract tags/status/ai_exclude from properties JSON into explicit columns'

export function up(db: Database): void {
  db.exec(`ALTER TABLE blocks ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`)
  db.exec(`ALTER TABLE blocks ADD COLUMN status TEXT NOT NULL DEFAULT 'note'`)
  db.exec(`ALTER TABLE blocks ADD COLUMN ai_exclude INTEGER NOT NULL DEFAULT 0`)

  db.exec(`CREATE INDEX IF NOT EXISTS idx_blocks_status ON blocks(status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_blocks_ai_exclude ON blocks(ai_exclude)`)
}

export function down(db: Database): void {
  db.exec(`DROP INDEX IF EXISTS idx_blocks_status`)
  db.exec(`DROP INDEX IF EXISTS idx_blocks_ai_exclude`)
}
