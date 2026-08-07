/**
 * SQLite 在线一致快照：VACUUM INTO + quick_check + SHA-256
 *
 * 快照剥离两类非核心数据（只清快照副本，VACUUM INTO 不修改源库）：
 * - 可重建的向量索引（block_vectors / vec_blocks / vector_entries…）：
 *   向量是可从正文重算的二级索引，占比可达 99%（4096 维 JSON 文本时代 425M 库中 ~415M）；
 *   剥离后备份/同步快照只含核心内容（KB~MB 级），恢复后经「重建索引」按需重建。
 * - entity_changes 同步拉取历史：新端以快照为基线起步（锚点之后的增量走 changes 段），
 *   基线之内的历史用不上，不随快照分发膨胀；源库历史的裁剪由同步 compaction
 *   （pruneChanges）负责。
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { CURRENT_SCHEMA_VERSION } from '@notefast/core'
import { getDb, getSchemaVersion } from '../db'
import { loadSqliteVec } from '../sqliteVec'

export interface LocalSnapshot {
  path: string
  sizeBytes: number
  sha256: string
  schemaVersion: number
  tempDir: string
}

export async function createLocalSnapshot(workDir: string): Promise<LocalSnapshot> {
  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true })
  const tempDir = join(workDir, `snap-${crypto.randomUUID()}`)
  mkdirSync(tempDir, { recursive: true })
  const dest = join(tempDir, 'notefast.db')

  const live = getDb()
  // VACUUM INTO 生成与当前库一致的紧凑快照（不修改原库）
  live.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
  stripSecondaryDataFromSnapshot(dest)

  const check = verifySnapshotFile(dest)
  const sizeBytes = statSync(dest).size
  const sha256 = await hashFile(dest)

  return {
    path: dest,
    sizeBytes,
    sha256,
    schemaVersion: check.schemaVersion,
    tempDir,
  }
}

/**
 * 备份/同步快照剥离非核心数据：清空向量索引并置 stale、清空 entity_changes 历史、
 * 回收空间（保留表结构供恢复后重建 / 继续累积）。
 */
function stripSecondaryDataFromSnapshot(path: string): void {
  const snap = new Database(path)
  try {
    const vecTables = snap.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vec_blocks\\_%' ESCAPE '\\'",
    ).all() as Array<{ name: string }>
    if (vecTables.length > 0) {
      try {
        loadSqliteVec(snap)
      } catch (e) {
        console.warn('[backup] 快照剥离 vec_blocks 时加载 vec0 失败（保持原样）:', e instanceof Error ? e.message : e)
      }
    }
    for (const t of vecTables) {
      try {
        snap.exec(`DELETE FROM "${t.name}"`)
      } catch (e) {
        console.warn('[backup] 清空 vec 表失败:', t.name, e instanceof Error ? e.message : e)
      }
    }
    for (const t of ['block_vectors', 'vector_entries', 'vector_generations']) {
      try { snap.exec(`DELETE FROM "${t}"`) } catch { /* 表可能不存在，忽略 */ }
    }
    try {
      snap.exec(
        `UPDATE vector_store_state
         SET status = 'stale', indexed_count = 0, active_generation = NULL, staging_generation = NULL,
             error = '快照不含向量索引，恢复后需重建', updated_at = datetime('now')
         WHERE id = 'default'`,
      )
    } catch { /* 表可能不存在，忽略 */ }
    // entity_changes：同步拉取历史不随快照分发（新端以快照为基线，只需锚点之后的增量）
    try { snap.exec('DELETE FROM entity_changes') } catch { /* 表可能不存在，忽略 */ }
    snap.exec('VACUUM')
  } finally {
    snap.close()
  }
}

export function verifySnapshotFile(path: string): { schemaVersion: number; ok: true } {
  if (!existsSync(path)) throw new Error(`快照文件不存在: ${path}`)
  const snap = new Database(path, { readonly: true })
  try {
    const row = snap.query('PRAGMA quick_check').get() as { quick_check: string } | undefined
    const result = row?.quick_check ?? ''
    if (result !== 'ok') {
      throw new Error(`PRAGMA quick_check 失败: ${result}`)
    }
    let schemaVersion = getSchemaVersion(snap)
    if (schemaVersion === 0) {
      // 极老备份：按当前基线可接受，但标记为 1 以便兼容检查
      schemaVersion = CURRENT_SCHEMA_VERSION
    }
    // 基本表存在性
    const tables = snap
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('blocks','notebooks')")
      .all() as Array<{ name: string }>
    if (tables.length < 2) {
      throw new Error('快照缺少 notebooks/blocks 表')
    }
    return { schemaVersion, ok: true }
  } finally {
    snap.close()
  }
}

export function cleanupSnapshot(tempDir: string): void {
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const chunk of stream) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}
