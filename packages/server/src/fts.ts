/**
 * FTS5 行定位：`id UNINDEXED` 上等值查询必全扫倒排，
 * 用 blocks_fts_map 把 block.id → fts rowid 做成普通 PK 查找。
 *
 * 触发器按 fts rowid 更新/删除（FTS5 唯一可索引定位键），避免每次改块扫全索引。
 */
import type { Database } from 'bun:sqlite'

const FTS_TRIGGERS = `
  CREATE TRIGGER blocks_fts_insert AFTER INSERT ON blocks
  BEGIN
    INSERT INTO blocks_fts (id, content) VALUES (NEW.id, NEW.content);
    INSERT INTO blocks_fts_map (block_id, fts_rowid) VALUES (NEW.id, last_insert_rowid());
  END;

  CREATE TRIGGER blocks_fts_update AFTER UPDATE OF content ON blocks
  BEGIN
    UPDATE blocks_fts SET content = NEW.content
    WHERE rowid = (SELECT fts_rowid FROM blocks_fts_map WHERE block_id = OLD.id);
  END;

  CREATE TRIGGER blocks_fts_delete AFTER DELETE ON blocks
  BEGIN
    DELETE FROM blocks_fts
    WHERE rowid = (SELECT fts_rowid FROM blocks_fts_map WHERE block_id = OLD.id);
    DELETE FROM blocks_fts_map WHERE block_id = OLD.id;
  END;
`

export function ensureFtsMapTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocks_fts_map (
      block_id TEXT PRIMARY KEY,
      fts_rowid INTEGER NOT NULL UNIQUE
    )
  `)
}

export function installBlocksFtsTriggers(db: Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS blocks_fts_insert;
    DROP TRIGGER IF EXISTS blocks_fts_update;
    DROP TRIGGER IF EXISTS blocks_fts_delete;
  `)
  db.exec(FTS_TRIGGERS)
}

/** 从 blocks 全量重建 FTS + 映射，并安装 rowid 触发器 */
export function rebuildBlocksFts(db: Database): void {
  ensureFtsMapTable(db)
  db.exec(`
    DROP TRIGGER IF EXISTS blocks_fts_insert;
    DROP TRIGGER IF EXISTS blocks_fts_update;
    DROP TRIGGER IF EXISTS blocks_fts_delete;
  `)
  db.exec('DELETE FROM blocks_fts')
  db.exec('DELETE FROM blocks_fts_map')
  db.exec('INSERT INTO blocks_fts(rowid, id, content) SELECT rowid, id, content FROM blocks')
  db.exec('INSERT INTO blocks_fts_map(block_id, fts_rowid) SELECT id, rowid FROM blocks')
  db.exec(FTS_TRIGGERS)
}
