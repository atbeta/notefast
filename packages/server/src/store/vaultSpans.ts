/**
 * vault_block_spans 数据访问 —— 顶层块源码区间的统一读写入口（RFC 0003 阶段 C）。
 *
 * 一行 = 一个顶层块在最近一次 ingest / 写回后的 body 区间 + 当时的子树指纹。
 * 每次写入都是**整表替换**（同 doc 先删后插），所以表非空即完整快照：
 * 写回看到某个当前块不在表里，才能确定它是新增块，而不是「表不完整」。
 */

import type { getDb } from '../db'

type Db = ReturnType<typeof getDb>

export interface VaultBlockSpanRow {
  doc_id: string
  block_id: string
  start: number
  end: number
  /** 记录 span 时该块子树的指纹（sha256），写回据此判断块是否被改过 */
  content_hash: string
}

export interface VaultBlockSpanInput {
  block_id: string
  start: number
  end: number
  content_hash: string
}

export function listVaultBlockSpans(db: Db, docId: string): VaultBlockSpanRow[] {
  return db
    .query('SELECT * FROM vault_block_spans WHERE doc_id = ? ORDER BY start ASC')
    .all(docId) as VaultBlockSpanRow[]
}

/** 整表替换某个文档的块区间（调用方已保证 rows 覆盖当前全部顶层块） */
export function replaceVaultBlockSpans(db: Db, docId: string, rows: VaultBlockSpanInput[]): void {
  db.transaction(() => {
    db.query('DELETE FROM vault_block_spans WHERE doc_id = ?').run(docId)
    if (rows.length === 0) return
    const insert = db.query(
      'INSERT INTO vault_block_spans (doc_id, block_id, start, end, content_hash) VALUES (?, ?, ?, ?, ?)',
    )
    for (const row of rows) {
      insert.run(docId, row.block_id, row.start, row.end, row.content_hash)
    }
  })()
}

export function deleteVaultBlockSpans(db: Db, docId: string): void {
  db.query('DELETE FROM vault_block_spans WHERE doc_id = ?').run(docId)
}
