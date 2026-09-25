import type { Database } from 'bun:sqlite'

/**
 * 023：文件夹投影的按块局部写回所需的块源码区间。
 *
 * 一行 = 一个**顶层块**在最近一次导入 / 写回后，相对正文（已剥离 frontmatter）的
 * `[start, end)` 行区间 + 当时的子树指纹。整表随每次导入 / 写回重写，
 * 因此「表非空」即「完整快照」——写回据此判断哪些块是新增的、哪些是改动的。
 *
 * 放在独立表而不是映射行里的 spans_json：块数可上千，整列 JSON 每次重写更贵，
 * 且按 doc_id 查询比解析 JSON 更直接。
 */
export const id = '023_projection_block_spans'
export const description = '文件夹投影：projection_block_spans 记录顶层块区间与内容指纹'

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projection_block_spans (
      doc_id        TEXT NOT NULL,
      block_id      TEXT NOT NULL,
      start         INTEGER NOT NULL,
      end           INTEGER NOT NULL,
      content_hash  TEXT NOT NULL,
      PRIMARY KEY (doc_id, block_id)
    )
  `)
}

export function down(db: Database): void {
  db.exec(`DROP TABLE IF EXISTS projection_block_spans`)
}
