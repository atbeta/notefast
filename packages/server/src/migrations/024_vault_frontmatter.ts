import type { Database } from 'bun:sqlite'

/**
 * 024：vault 写回保真的 frontmatter 透传（RFC 0003 阶段 B）。
 *
 * - vault_files.frontmatter_raw：用户手写 frontmatter 原文（不含首尾 `---`，无则 NULL），
 *   写回时做行级透传，NoteFast 只增删改 tags / notefast_ai_exclude / notefast_status 三键。
 * - vault_files.meta_hash：sha256(JSON[tags, ai_exclude, status])，用于修正「元数据变更的回声判定」——
 *   updateBlock 对 tags / ai_exclude 用 touchUpdatedAt:false，doc.updated_at 不变，
 *   仅靠 doc_updated_at 会把真实元数据编辑误判成 ingest 回声。阶段 B 起改为
 *   doc_updated_at 相同 且 meta_hash 相同 才算回声。
 */
export const id = '024_vault_frontmatter'
export const description = 'vault 写回保真：vault_files 加 frontmatter_raw / meta_hash'

export function up(db: Database): void {
  db.exec(`ALTER TABLE vault_files ADD COLUMN frontmatter_raw TEXT`)
  db.exec(`ALTER TABLE vault_files ADD COLUMN meta_hash TEXT`)
}

export function down(db: Database): void {
  // SQLite 3.35+ 支持 DROP COLUMN；旧版本保留列无害
  try {
    db.exec(`ALTER TABLE vault_files DROP COLUMN meta_hash`)
    db.exec(`ALTER TABLE vault_files DROP COLUMN frontmatter_raw`)
  } catch {
    /* 旧 SQLite 不支持 DROP COLUMN */
  }
}
