import type { Database } from 'bun:sqlite'

/**
 * 012：blocks_fts_update 触发器改为限定 content 列。
 *
 * 原 `AFTER UPDATE ON blocks` 无条件对每个被改 block 重建 FTS 倒排索引——
 * 软删除/恢复等不动 content 的 UPDATE 也会触发，5000 块文档删除实测 ~2.5s
 * （FTS 重建随库内块数近似 O(n²)）。改为 `AFTER UPDATE OF content` 后，
 * 仅 content 真正被 SET 才同步 FTS，软删除/恢复降到毫秒级；检索侧本就
 * 以 is_deleted 过滤，软删行保留在 FTS 不影响召回正确性。
 */
export const id = '012_fts_update_of_content'
export const description = 'blocks_fts_update 仅 content 变化时重建（修删大文档慢）'

export function up(db: Database): void {
  db.exec(`DROP TRIGGER IF EXISTS blocks_fts_update`)
  db.exec(`
    CREATE TRIGGER blocks_fts_update AFTER UPDATE OF content ON blocks
    BEGIN
      UPDATE blocks_fts SET content = NEW.content WHERE id = OLD.id;
    END;
  `)
}
