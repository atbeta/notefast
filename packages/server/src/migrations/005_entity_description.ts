import type { Database } from 'bun:sqlite'

export const id = '005_entity_description'
export const description = 'entity one-line description (E2, background LLM)'

export function up(db: Database): void {
  // SQLite 无 ADD COLUMN IF NOT EXISTS；用 PRAGMA table_info 防御（历史库可能已有列）
  const columns = db.query(`PRAGMA table_info(entities)`).all() as Array<{ name: string }>
  if (!columns.some((c) => c.name === 'description')) {
    db.exec(`ALTER TABLE entities ADD COLUMN description TEXT`)
  }
}
