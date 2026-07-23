import type { Database } from 'bun:sqlite'

export const id = '008_soft_delete'
export const description = 'Soft-delete blocks with is_deleted/delete_id and restore support'

export function up(db: Database): void {
  db.exec(`ALTER TABLE blocks ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0`)
  db.exec(`ALTER TABLE blocks ADD COLUMN delete_id TEXT`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_blocks_is_deleted ON blocks(is_deleted)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_blocks_is_deleted_date ON blocks(is_deleted, updated_at DESC)`)

  // 替换 trg_blocks_au：软删除时 is_erased=1，普通更新 is_erased=0
  db.exec(`DROP TRIGGER IF EXISTS trg_blocks_au`)
  db.exec(`
    CREATE TRIGGER trg_blocks_au AFTER UPDATE ON blocks
    BEGIN
      INSERT INTO entity_changes (entity_name, entity_id, is_erased, change_id, component_id, actor)
      VALUES ('block', NEW.id,
        CASE WHEN OLD.is_deleted = 0 AND NEW.is_deleted = 1 THEN 1 ELSE 0 END,
        lower(hex(randomblob(16))), 'system', 'system');
    END
  `)
}

export function down(db: Database): void {
  db.exec(`DROP TRIGGER IF EXISTS trg_blocks_au`)
  db.exec(`
    CREATE TRIGGER trg_blocks_au AFTER UPDATE ON blocks
    BEGIN
      INSERT INTO entity_changes (entity_name, entity_id, change_id, component_id, actor)
      VALUES ('block', NEW.id, lower(hex(randomblob(16))), 'system', 'system');
    END
  `)
  db.exec(`DROP INDEX IF EXISTS idx_blocks_is_deleted_date`)
  db.exec(`DROP INDEX IF EXISTS idx_blocks_is_deleted`)
}
