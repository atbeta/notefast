import type { Database } from 'bun:sqlite'

/**
 * 024：投影文件映射表（RFC 0007 D2/D6）。
 *
 * 入方向的入口索引：给定 `rel_path` 立刻知道对应哪篇文档、上次见到的内容 sha。
 * `content_sha256` 承担两个职责（比 vault 的四个少一半，因为投影是单向权威）：
 *   - **变更短路**：sha 未变 → 不解析不对齐（我们自己写回产生的回声也在这里被吞掉）
 *   - **冲突检测**：写文件前核对磁盘 sha，不等 = 外部改过
 *
 * `doc_id` 唯一：一篇文档在投影文件夹里只应有一个文件。
 * 软删除不在这里表达——删除由库的回收站负责（D9）。
 */
export const id = '024_projection_files'
export const description = '文件夹投影：projection_files 记录 rel_path ↔ doc_id 与内容指纹'

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projection_files (
      notebook_id     TEXT NOT NULL,
      rel_path        TEXT NOT NULL,
      doc_id          TEXT NOT NULL,
      content_sha256  TEXT NOT NULL,
      size            INTEGER NOT NULL,
      mtime_ms        INTEGER NOT NULL,
      doc_updated_at  TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      PRIMARY KEY (notebook_id, rel_path)
    )
  `)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_files_doc ON projection_files(notebook_id, doc_id)`)
}

export function down(db: Database): void {
  db.exec(`DROP INDEX IF EXISTS idx_projection_files_doc`)
  db.exec(`DROP TABLE IF EXISTS projection_files`)
}
