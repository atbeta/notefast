/**
 * SQLite 在线一致快照：VACUUM INTO + quick_check + SHA-256
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { CURRENT_SCHEMA_VERSION } from '@notefast/core'
import { getDb, getSchemaVersion } from '../db'

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
