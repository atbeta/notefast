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
