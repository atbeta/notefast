/**
 * 客户端错误埋点 API
 *
 * POST /api/v1/client-errors    接收前端批量上报（componentDidCatch / window.onerror /
 *                                unhandledrejection 经 errorReporter 集中投递）
 *
 * 鉴权：任何已登录 session / api token（无 write scope 也可——错误日志不是写操作）。
 *   未鉴权请求会被 authMiddleware 拒，避免被外部站点灌垃圾。
 *
 * 存储：直接 INSERT 到 client_errors 表，hash 字段用于服务端聚合去重（后续可加
 *   按 hash 的 occurrences 计数；当前每次插入 = 新行，由客户端自己做窗口去重）。
 *
 * 滚动 TTL：7 天，initClientErrors() 在 server.start() 阶段清理 expires。
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getDb } from '../db'

const clientErrors = new Hono()

const errorReportSchema = z.object({
  source: z.enum(['boundary', 'window', 'unhandledrejection']),
  message: z.string().min(1).max(500),
  stack: z.string().max(8192).optional(),
  componentStack: z.string().max(8192).optional(),
  hash: z.string().min(1).max(64),
  url: z.string().max(2048).optional(),
  appVersion: z.string().max(64).optional(),
  userAgent: z.string().max(512).optional(),
  extra: z.record(z.unknown()).optional(),
})

const requestSchema = z.object({
  errors: z.array(errorReportSchema).min(1).max(50),
})

clientErrors.post(
  '/',
  zValidator('json', requestSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: 'invalid_payload', issues: result.error.issues }, 400)
    }
    return undefined
  }),
  (c) => {
    const db = getDb()
    const userId = c.get('userId' as never) as string | undefined
    const { errors } = c.req.valid('json')

    const stmt = db.prepare(
      `INSERT INTO client_errors
        (source, message, stack, component_stack, url, user_agent, app_version, user_id, hash, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )

    let accepted = 0
    db.transaction(() => {
      for (const e of errors) {
        stmt.run(
          e.source,
          e.message,
          e.stack ?? null,
          e.componentStack ?? null,
          e.url ?? null,
          e.userAgent ?? null,
          e.appVersion ?? null,
          userId ?? null,
          e.hash,
          e.extra ? JSON.stringify(e.extra) : null,
        )
        accepted++
      }
    })()

    return c.json({ accepted })
  },
)

export default clientErrors

/** 启动时清理 7 天前的错误日志；幂等可重复调用 */
export function initClientErrors(): void {
  const db = getDb()
  db.exec(`DELETE FROM client_errors WHERE received_at < datetime('now', '-7 days')`)
}