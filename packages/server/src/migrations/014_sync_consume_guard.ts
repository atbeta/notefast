import type { Database } from 'bun:sqlite'

/**
 * 014：多端同步 consume 回波抑制 + entity_changes 记录行级时间。
 *
 * 背景：consume 直写 SQL 原以为「不经 store hooks 就不会进 change feed」，
 * 但 entity_changes 由 blocks 表 trigger（trg_blocks_ai/au/ad）驱动，raw SQL
 * 同样触发——消费进来的远端变更被本端再发布一次（回波），变更量随设备数膨胀。
 *
 * 方案：sync_consume_guard 单行表作为「consume 临界区」标记，三个 trigger 加
 * WHEN NOT EXISTS 子句——guard 有行时静默。consume 把「guard 插入 → 应用变更 →
 * guard 删除」放在同一个无 await 的同步事务里（单线程下本地写入不可能落入该
 * 窗口被误挡），本地正常编辑照常进 feed。
 *
 * 同时给 entity_changes 加 entity_updated_at（trigger 记录事件后行的 updated_at，
 * 毫秒精度）：软删事件的 NEW.updated_at 即删除时刻，发布端把它作为 deleted_at
 * 附上线，消费端用它做 LWW 裁决，而不是消费时刻（离线批量消费「删除 T1 → 恢复
 * T2」时，消费时刻 > T2 会让恢复 upsert 被跳过，本端永久停在已删除）。
 */
export const id = '014_sync_consume_guard'
export const description = 'consume guard 抑制 change feed 回波 + entity_changes.entity_updated_at'

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_consume_guard (
      id INTEGER PRIMARY KEY CHECK (id = 1)
    );
  `)

  const cols = db.query('PRAGMA table_info(entity_changes)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'entity_updated_at')) {
    db.exec('ALTER TABLE entity_changes ADD COLUMN entity_updated_at TEXT')
  }

  db.exec(`
    DROP TRIGGER IF EXISTS trg_blocks_ai;
    DROP TRIGGER IF EXISTS trg_blocks_au;
    DROP TRIGGER IF EXISTS trg_blocks_ad;

    CREATE TRIGGER trg_blocks_ai AFTER INSERT ON blocks
    WHEN NOT EXISTS (SELECT 1 FROM sync_consume_guard)
    BEGIN
      INSERT INTO entity_changes (entity, entity_id, actor, entity_updated_at)
      VALUES ('block', NEW.id, 'server', NEW.updated_at);
    END;

    CREATE TRIGGER trg_blocks_au AFTER UPDATE ON blocks
    WHEN NOT EXISTS (SELECT 1 FROM sync_consume_guard)
    BEGIN
      INSERT INTO entity_changes (entity, entity_id, is_erased, actor, entity_updated_at)
      VALUES ('block', NEW.id,
        CASE WHEN OLD.is_deleted = 0 AND NEW.is_deleted = 1 THEN 1 ELSE 0 END,
        'server', NEW.updated_at);
    END;

    CREATE TRIGGER trg_blocks_ad AFTER DELETE ON blocks
    WHEN NOT EXISTS (SELECT 1 FROM sync_consume_guard)
    BEGIN
      INSERT INTO entity_changes (entity, entity_id, is_erased, actor, entity_updated_at)
      VALUES ('block', OLD.id, 1, 'server', OLD.updated_at);
    END;
  `)
}

export function down(db: Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_blocks_ai;
    DROP TRIGGER IF EXISTS trg_blocks_au;
    DROP TRIGGER IF EXISTS trg_blocks_ad;
    DROP TABLE IF EXISTS sync_consume_guard;

    CREATE TRIGGER trg_blocks_ai AFTER INSERT ON blocks
    BEGIN
      INSERT INTO entity_changes (entity, entity_id, actor)
      VALUES ('block', NEW.id, 'server');
    END;

    CREATE TRIGGER trg_blocks_au AFTER UPDATE ON blocks
    BEGIN
      INSERT INTO entity_changes (entity, entity_id, is_erased, actor)
      VALUES ('block', NEW.id,
        CASE WHEN OLD.is_deleted = 0 AND NEW.is_deleted = 1 THEN 1 ELSE 0 END,
        'server');
    END;

    CREATE TRIGGER trg_blocks_ad AFTER DELETE ON blocks
    BEGIN
      INSERT INTO entity_changes (entity, entity_id, is_erased, actor)
      VALUES ('block', OLD.id, 1, 'server');
    END;
  `)
}
