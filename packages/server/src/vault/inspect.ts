/**
 * vault 巡检数据（RFC 0005 U-9）：冲突副本与 `.trash/` 里的文件。
 *
 * 两者的数据来源刻意不同：
 * - 冲突副本：按文件名约定查 `vault_files`（副本会被 ingest 成新文档），不扫盘
 * - `.trash/`：被忽略目录，不在索引里，只能走文件系统
 */

import { type Dirent, existsSync, readdirSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import type { getDb } from '../db'

type Db = ReturnType<typeof getDb>

/** 写回冲突与文件同步冲突共用这个中缀（writeback.ts / fileSync.ts） */
export const CONFLICT_INFIX = '.notefast-conflict-'

export interface VaultConflictFile {
  rel_path: string
  name: string
  doc_id: string
  /** 原文件路径（去掉中缀与时间戳）；推断不出时为 null */
  original_path: string | null
}

/**
 * 冲突副本清单（新→旧由 rel_path 里的时间戳决定，这里按路径排序保持稳定）。
 * `original_path` 尽力还原：`a.notefast-conflict-20260910-120000.md` → `a.md`。
 */
export function listVaultConflicts(
  db: Db,
  notebookId: string,
): { count: number; files: VaultConflictFile[] } {
  const rows = db
    .query(
      `SELECT rel_path, doc_id FROM vault_files
        WHERE notebook_id = ? AND deleted_at IS NULL AND rel_path LIKE ?
        ORDER BY rel_path ASC`,
    )
    .all(notebookId, `%${CONFLICT_INFIX}%`) as Array<{ rel_path: string; doc_id: string }>

  const files = rows.map((row) => {
    const dir = posix.dirname(row.rel_path)
    const base = posix.basename(row.rel_path)
    const idx = base.indexOf(CONFLICT_INFIX)
    const name = base.replace(/\.md$/i, '')
    let original: string | null = null
    if (idx > 0) {
      const stem = base.slice(0, idx)
      const restored = `${stem}.md`
      original = dir === '.' ? restored : posix.join(dir, restored)
    }
    return { rel_path: row.rel_path, name, doc_id: row.doc_id, original_path: original }
  })

  return { count: files.length, files }
}

export interface VaultTrashFile {
  /** 相对 `.trash/` 的路径（保留原目录结构） */
  path: string
  name: string
  size: number
  mtime_ms: number
}

/**
 * `.trash/` 里的文件（含子目录，跳过 `.` 开头的项）。
 * 单层失败不影响整体——巡检信息不该因为一个坏目录整页报错。
 */
export async function listVaultTrash(
  root: string,
  opts: { limit?: number } = {},
): Promise<{ count: number; files: VaultTrashFile[]; truncated: boolean }> {
  const limit = opts.limit ?? 500
  const trashRoot = join(root, '.trash')
  const files: VaultTrashFile[] = []
  if (!existsSync(trashRoot)) return { count: 0, files, truncated: false }

  const walk = (dir: string, rel: string): void => {
    if (files.length > limit) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length > limit) return
      const name = String(entry.name)
      if (name.startsWith('.')) continue
      const abs = join(dir, name)
      const nextRel = rel === '' ? name : `${rel}/${name}`
      if (entry.isDirectory()) {
        walk(abs, nextRel)
        continue
      }
      if (!entry.isFile()) continue
      let size = 0
      let mtime = 0
      try {
        const st = statSync(abs)
        size = st.size
        mtime = st.mtimeMs
      } catch {
        /* 读不到 stat 也给出行，size/mtime 记 0 */
      }
      files.push({ path: nextRel, name, size, mtime_ms: mtime })
    }
  }

  walk(trashRoot, '')
  const truncated = files.length > limit
  const trimmed = truncated ? files.slice(0, limit) : files
  trimmed.sort((a, b) => b.mtime_ms - a.mtime_ms)
  return { count: trimmed.length, files: trimmed, truncated }
}
