/**
 * vault_sync_state 数据访问 —— 文件同步基线（RFC 0004）。
 *
 * 只记「上次与远端一致时」的状态，不记业务语义：ingest / 写回都不碰这张表。
 */

import type { getDb } from '../db'

type Db = ReturnType<typeof getDb>

export interface VaultSyncStateRow {
  rel_path: string
  /** 上次同步时的内容 sha；null = 上次同步时本地不存在（该文件已被本端删除并推送过 tombstone） */
  synced_blob: string | null
  synced_size: number
  synced_mtime_ms: number
  synced_at: string
}

export interface VaultSyncStateInput {
  rel_path: string
  synced_blob: string | null
  synced_size: number
  synced_mtime_ms: number
}

export function listVaultSyncState(db: Db): VaultSyncStateRow[] {
  return db.query('SELECT * FROM vault_sync_state').all() as VaultSyncStateRow[]
}

export function getVaultSyncState(db: Db, relPath: string): VaultSyncStateRow | null {
  return (
    (db.query('SELECT * FROM vault_sync_state WHERE rel_path = ?').get(relPath) as
      | VaultSyncStateRow
      | undefined) ?? null
  )
}

/** 批量写入基线（同一事务，避免中断后一半新一半旧） */
export function upsertVaultSyncState(db: Db, rows: VaultSyncStateInput[]): void {
  if (rows.length === 0) return
  const stmt = db.query(
    `INSERT INTO vault_sync_state (rel_path, synced_blob, synced_size, synced_mtime_ms, synced_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(rel_path) DO UPDATE SET
       synced_blob = excluded.synced_blob,
       synced_size = excluded.synced_size,
       synced_mtime_ms = excluded.synced_mtime_ms,
       synced_at = excluded.synced_at`,
  )
  db.transaction(() => {
    for (const row of rows) {
      stmt.run(row.rel_path, row.synced_blob, row.synced_size, row.synced_mtime_ms)
    }
  })()
}

export function deleteVaultSyncState(db: Db, relPaths: string[]): void {
  if (relPaths.length === 0) return
  const placeholders = relPaths.map(() => '?').join(',')
  db.query(`DELETE FROM vault_sync_state WHERE rel_path IN (${placeholders})`).run(
    ...(relPaths as [string, ...string[]]),
  )
}

export function countVaultSyncState(db: Db): number {
  return (db.query('SELECT count(*) AS c FROM vault_sync_state').get() as { c: number }).c
}
