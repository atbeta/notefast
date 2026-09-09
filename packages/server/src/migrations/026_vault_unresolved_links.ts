import type { Database } from 'bun:sqlite'

/**
 * 026：vault wikilink 的未解析目标（RFC 0002 §引用解析、计划 V-301）。
 *
 * `[[目标]]` 指向尚不存在的笔记时不建 ref，把「谁引用了什么名字」记在这里；
 * 目标文件后来被创建（或改名后重现）时按 target_name 反查，补建引用（软解析的「后到先解」）。
 * 行随源块的 ingest 整块重写，与 block_refs 的 wikilink 子集同生命周期。
 */
export const id = '026_vault_unresolved_links'
export const description = 'vault 引用：vault_unresolved_links 记录未解析的 wikilink 目标'

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_unresolved_links (
      notebook_id     TEXT NOT NULL,
      source_block_id TEXT NOT NULL,
      target_name     TEXT NOT NULL,
      anchor          TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (source_block_id, target_name, anchor)
    )
  `)
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_vault_unresolved_target ON vault_unresolved_links(notebook_id, target_name)`,
  )
}

export function down(db: Database): void {
  db.exec(`DROP INDEX IF EXISTS idx_vault_unresolved_target`)
  db.exec(`DROP TABLE IF EXISTS vault_unresolved_links`)
}
