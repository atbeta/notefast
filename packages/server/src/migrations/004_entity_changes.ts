import type { Database } from 'bun:sqlite'

export const id = '004_entity_changes'
export const description = 'Audit + sync queue + soft-delete tracking for block changes'

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE entity_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_name TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      hash TEXT NOT NULL DEFAULT '',
      is_erased INTEGER NOT NULL DEFAULT 0,
      is_synced INTEGER NOT NULL DEFAULT 0,
      change_id TEXT NOT NULL,
      component_id TEXT NOT NULL DEFAULT 'system',
      actor TEXT NOT NULL DEFAULT 'system',
      utc_date_changed TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  db.exec(`CREATE INDEX idx_entity_changes_entity ON entity_changes(entity_name, entity_id)`)
  db.exec(`CREATE INDEX idx_entity_changes_synced ON entity_changes(is_synced, id)`)
  db.exec(`CREATE INDEX idx_entity_changes_date ON entity_changes(utc_date_changed DESC)`)
  db.exec(`CREATE UNIQUE INDEX idx_entity_changes_change_id ON entity_changes(change_id)`)

  db.exec(`
    CREATE TRIGGER trg_blocks_ai AFTER INSERT ON blocks
    BEGIN
      INSERT INTO entity_changes (entity_name, entity_id, change_id, component_id, actor)
      VALUES ('block', NEW.id, lower(hex(randomblob(16))), 'system', 'system');
    END
  `)

  db.exec(`
    CREATE TRIGGER trg_blocks_au AFTER UPDATE ON blocks
    BEGIN
      INSERT INTO entity_changes (entity_name, entity_id, change_id, component_id, actor)
      VALUES ('block', NEW.id, lower(hex(randomblob(16))), 'system', 'system');
    END
  `)

  db.exec(`
    CREATE TRIGGER trg_blocks_ad AFTER DELETE ON blocks
    BEGIN
      INSERT INTO entity_changes (entity_name, entity_id, is_erased, change_id, component_id, actor)
      VALUES ('block', OLD.id, 1, lower(hex(randomblob(16))), 'system', 'system');
    END
  `)
}

export function down(db: Database): void {
  db.exec(`DROP TRIGGER IF EXISTS trg_blocks_ad`)
  db.exec(`DROP TRIGGER IF EXISTS trg_blocks_au`)
  db.exec(`DROP TRIGGER IF EXISTS trg_blocks_ai`)
  db.exec(`DROP INDEX IF EXISTS idx_entity_changes_change_id`)
  db.exec(`DROP INDEX IF EXISTS idx_entity_changes_date`)
  db.exec(`DROP INDEX IF EXISTS idx_entity_changes_synced`)
  db.exec(`DROP INDEX IF EXISTS idx_entity_changes_entity`)
  db.exec(`DROP TABLE IF EXISTS entity_changes`)
}
