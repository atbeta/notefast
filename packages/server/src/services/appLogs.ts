/**
 * 服务端应用日志（app_logs）存储层。
 *
 * - logAppEvent / logAppError：写 app_logs 环形表（30 天 / 2000 行，initAppLogs 裁剪）
 * - emitAppEvent（events.ts）双写：console（现状）+ 本表，用户侧「维护」页可见
 * - 慢请求、维护结果、AI 失败等从各自调用点显式落库
 */

import { getDb } from '../db'

/** 环形上限：最多保留行数 */
export const APP_LOGS_MAX_ROWS = 2000
/** 环形 TTL：30 天（对齐 tombstone 保留期） */
export const APP_LOGS_TTL_DAYS = 30

export type AppLogLevel = 'info' | 'warn' | 'error'

export interface AppLogEntry {
  level: AppLogLevel
  source: string
  message: string
  fields?: Record<string, unknown>
}

/** 写一条日志（fields 会 JSON 序列化）；写失败静默——日志失败不应影响主流程 */
export function logAppEvent(entry: AppLogEntry): void {
  try {
    const db = getDb()
    db.query('INSERT INTO app_logs (level, source, message, fields) VALUES (?, ?, ?, ?)').run(
      entry.level,
      entry.source,
      entry.message,
      entry.fields ? JSON.stringify(entry.fields) : null,
    )
  } catch {
    /* 日志失败不影响主流程 */
  }
}

export function logAppInfo(source: string, message: string, fields?: Record<string, unknown>): void {
  logAppEvent({ level: 'info', source, message, fields })
}

export function logAppWarn(source: string, message: string, fields?: Record<string, unknown>): void {
  logAppEvent({ level: 'warn', source, message, fields })
}

export function logAppError(source: string, message: string, fields?: Record<string, unknown>): void {
  logAppEvent({ level: 'error', source, message, fields })
}

/** 最近日志（默认 100 条，最多 500）；fields 反序列化返回 */
export function listAppLogs(limit = 100): Array<{
  id: number
  ts: string
  level: AppLogLevel
  source: string
  message: string
  fields: Record<string, unknown> | null
}> {
  const db = getDb()
  const safeLimit = Math.min(Math.max(limit, 1), 500)
  const rows = db
    .query('SELECT id, ts, level, source, message, fields FROM app_logs ORDER BY id DESC LIMIT ?')
    .all(safeLimit) as Array<{
    id: number
    ts: string
    level: AppLogLevel
    source: string
    message: string
    fields: string | null
  }>
  return rows.map((r) => ({
    ...r,
    fields: r.fields ? (JSON.parse(r.fields) as Record<string, unknown>) : null,
  }))
}

/**
 * 最近的 vault 写回冲突（`/api/v1/vault/status.conflicts` 用）。
 * 从 app_logs 读 `doc.vault_writeback_conflict`：24h 计数 + 最近 N 条冲突副本路径。
 */
export function listVaultWritebackConflicts(
  opts: { sinceHours?: number; limit?: number } = {},
): { count: number; paths: string[] } {
  const db = getDb()
  const hours = opts.sinceHours ?? 24
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100)
  const count = (
    db
      .query(
        `SELECT count(*) AS c FROM app_logs
         WHERE message = 'doc.vault_writeback_conflict' AND ts >= datetime('now', ?)`,
      )
      .get(`-${hours} hours`) as { c: number }
  ).c
  const rows = db
    .query(
      `SELECT fields FROM app_logs
       WHERE message = 'doc.vault_writeback_conflict' AND ts >= datetime('now', ?)
       ORDER BY id DESC LIMIT ?`,
    )
    .all(`-${hours} hours`, limit) as Array<{ fields: string | null }>
  const paths: string[] = []
  for (const row of rows) {
    if (!row.fields) continue
    try {
      const fields = JSON.parse(row.fields) as Record<string, unknown>
      const p = fields.conflict_path ?? fields.rel_path
      if (typeof p === 'string' && p) paths.push(p)
    } catch {
      /* 坏日志跳过 */
    }
  }
  return { count, paths }
}

/** 启动时裁剪环形日志（TTL + 行数上限）；幂等可重复调用 */
export function initAppLogs(): void {
  const db = getDb()
  db.exec(`DELETE FROM app_logs WHERE ts < datetime('now', '-${APP_LOGS_TTL_DAYS} days')`)
  // 行数超限：删最旧，保留最新 APP_LOGS_MAX_ROWS
  db.exec(`
    DELETE FROM app_logs WHERE id IN (
      SELECT id FROM app_logs ORDER BY id DESC LIMIT -1 OFFSET ${APP_LOGS_MAX_ROWS}
    )
  `)
}
