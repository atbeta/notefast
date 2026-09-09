import type { Database } from 'bun:sqlite'

/**
 * 023：vault mode 数据基础（RFC 0001 / 0002）。
 *
 * - notebooks.kind：'db'（SQLite 权威，默认）| 'vault'（文件夹权威，SQLite 是派生索引）
 * - notebooks.vault_root：vault 根目录绝对路径（kind='vault' 时非空）
 * - vault_files：文件 ↔ 文档映射表。文件身份 = vault 相对路径；文档身份 = 文档根 block id。
 *   content_sha256 同时用于「变更短路」「回声抑制」「rename 配对」「写回乐观并发」。
 *   deleted_at 非空 = 文件已从 vault 消失、文档进回收站；同 sha 再出现时恢复而非新建。
 */
export const id = '023_vault_mode'
export const description = 'vault mode：notebook kind + vault_files 文件映射表'

export function up(db: Database): void {
  db.exec(`ALTER TABLE notebooks ADD COLUMN kind TEXT NOT NULL DEFAULT 'db'`)
  db.exec(`ALTER TABLE notebooks ADD COLUMN vault_root TEXT`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_files (
      notebook_id     TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
      rel_path        TEXT NOT NULL,
      doc_id          TEXT NOT NULL,
      content_sha256  TEXT NOT NULL,
      size            INTEGER NOT NULL DEFAULT 0,
      mtime_ms        INTEGER NOT NULL DEFAULT 0,
      ingested_at     TEXT NOT NULL DEFAULT (datetime('now')),
      doc_updated_at  TEXT NOT NULL DEFAULT '',
      deleted_at      TEXT,
      PRIMARY KEY (notebook_id, rel_path)
    )
  `)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_files_doc ON vault_files(doc_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_vault_files_sha ON vault_files(notebook_id, content_sha256)`)
}

export function down(db: Database): void {
  db.exec(`DROP INDEX IF EXISTS idx_vault_files_sha`)
  db.exec(`DROP INDEX IF EXISTS idx_vault_files_doc`)
  db.exec(`DROP TABLE IF EXISTS vault_files`)
  // SQLite 3.35+ 支持 DROP COLUMN；旧版本保留列无害
  try {
    db.exec(`ALTER TABLE notebooks DROP COLUMN vault_root`)
    db.exec(`ALTER TABLE notebooks DROP COLUMN kind`)
  } catch {
    /* 旧 SQLite 不支持 DROP COLUMN */
  }
}
