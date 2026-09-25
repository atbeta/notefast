/**
 * 投影状态（RFC 0007 S3：扩展既有面，不新开命名空间）。
 *
 * 给用户的三个问题各一个答案：
 *   1. 我的投影文件夹在哪、有几个文件 —— folder / files
 *   2. 它跟上没有 —— pending（映射存在但内容与磁盘不一致）
 *   3. 出过冲突吗 —— conflicts
 */

import type { getDb } from '../db'
import { listProjectionFiles } from '../store/projectionFiles'
import { listProjectionBlockSpans } from '../store/projectionSpans'
import { getLiveDocById } from '../store/blocks'

type Db = ReturnType<typeof getDb>

export interface ProjectionConflictView {
  docId: string
  relPath: string
  conflictPath: string | null
  at: string
}

export interface ProjectionStatusView {
  enabled: boolean
  /** 投影根目录；未启用时为 null */
  root: string | null
  /** 已建立映射的文件数 */
  files: number
  /** 映射指向的文档仍可用的文件数 */
  liveFiles: number
  /** 有区间记录的文件数（这些能局部写回，其余退回整篇） */
  patchableFiles: number
  /** 最近 24h 的冲突计数与路径 */
  conflicts: { count24h: number; recent: ProjectionConflictView[] }
}

/** 最近的冲突事件（读 app_logs，与 vault 的 status.conflicts 同思路） */
function recentConflicts(db: Db, limit = 10): ProjectionConflictView[] {
  try {
    const rows = db
      .query(
        `SELECT fields, ts FROM app_logs
         WHERE message = 'doc.projection_writeback_conflict'
         ORDER BY ts DESC LIMIT ?`,
      )
      .all(limit) as Array<{ fields: string | null; ts: string }>
    const out: ProjectionConflictView[] = []
    for (const row of rows) {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = row.fields ? (JSON.parse(row.fields) as Record<string, unknown>) : {}
      } catch {
        /* 字段损坏就当空 */
      }
      // `fields` 是 logAppEvent 展平后写入的那一份：含 ts/source/target/rel_path 等
      const target = parsed.target
      out.push({
        docId: target && typeof target === 'object' ? String((target as { id?: unknown }).id ?? '') : '',
        relPath: typeof parsed.rel_path === 'string' ? parsed.rel_path : '',
        conflictPath: typeof parsed.conflict_path === 'string' ? parsed.conflict_path : null,
        at: row.ts,
      })
    }
    return out
  } catch {
    return []
  }
}

function countConflicts24h(db: Db): number {
  try {
    const row = db
      .query(
        `SELECT count(*) AS c FROM app_logs
         WHERE message = 'doc.projection_writeback_conflict'
           AND ts >= datetime('now', '-24 hours')`,
      )
      .get() as { c: number } | undefined
    return row?.c ?? 0
  } catch {
    return 0
  }
}

export function projectionStatus(
  db: Db,
  notebookId: string,
  opts: { enabled: boolean; root: string | null },
): ProjectionStatusView {
  if (!opts.enabled || !opts.root) {
    return {
      enabled: false,
      root: null,
      files: 0,
      liveFiles: 0,
      patchableFiles: 0,
      conflicts: { count24h: 0, recent: [] },
    }
  }

  const rows = listProjectionFiles(db, notebookId)
  let live = 0
  let patchable = 0
  for (const row of rows) {
    if (getLiveDocById(db, row.doc_id)) live++
    if (listProjectionBlockSpans(db, row.doc_id).length > 0) patchable++
  }

  return {
    enabled: true,
    root: opts.root,
    files: rows.length,
    liveFiles: live,
    patchableFiles: patchable,
    conflicts: { count24h: countConflicts24h(db), recent: recentConflicts(db) },
  }
}
