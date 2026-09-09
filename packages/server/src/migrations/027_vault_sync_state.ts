import type { Database } from 'bun:sqlite'

/**
 * 027：vault 文件同步的本端状态（RFC 0004）。
 *
 * 一行 = 一个文件「上次与远端一致时」的样子，作为三方比较的 base：
 * 本地 sha == synced_blob → 本地未变；远端条目 blob == synced_blob → 远端未变；
 * 两者都变且不同 → 冲突。与 vault_files（文档映射）解耦：索引删了重建也不重复同步。
 */
export const id = '027_vault_sync_state'
export const description = 'vault 文件同步：vault_sync_state 记录每文件的上次同步基线'

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_sync_state (
      rel_path        TEXT PRIMARY KEY,
      synced_blob     TEXT,
      synced_size     INTEGER NOT NULL DEFAULT 0,
      synced_mtime_ms INTEGER NOT NULL DEFAULT 0,
      synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
}

export function down(db: Database): void {
  db.exec(`DROP TABLE IF EXISTS vault_sync_state`)
}
