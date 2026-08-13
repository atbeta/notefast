import type { Database } from 'bun:sqlite'

/**
 * 013：block_refs 加 (source_id, target_id) 唯一索引，作为建链 TOCTOU 的兜底。
 *
 * 列组合不含 ref_type：现有读写语义是「同一对块只允许一条引用」——
 * findRefByPair / api/refs POST 均不按 ref_type 区分（人工 link 存在时
 * ai_auto 不建，反之亦然），所以唯一性落在 (source_id, target_id) 上。
 *
 * 存量库可能已因并发写入存在重复行：先去重（保留 id 最小 = 最早创建的一行），
 * 再建唯一索引。
 */
export const id = '013_block_refs_unique_pair'
export const description = 'block_refs 同 (source,target) 唯一（先去重再建唯一索引）'

export function up(db: Database): void {
  // 同一对 (source_id, target_id) 只保留最早创建的一行（AUTOINCREMENT id 最小者）
  db.exec(`
    DELETE FROM block_refs
    WHERE id NOT IN (SELECT MIN(id) FROM block_refs GROUP BY source_id, target_id)
  `)
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_refs_pair_unique ON block_refs(source_id, target_id)
  `)
}

export function down(db: Database): void {
  db.exec(`DROP INDEX IF EXISTS idx_refs_pair_unique`)
}
