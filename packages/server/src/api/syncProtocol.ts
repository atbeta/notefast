/**
 * 同步协议 API（方案 A：客户端与 Web 共享 S3）
 *
 * 路由：
 * - GET  /api/v1/sync/protocol       状态（configured / state / lastRun）
 * - POST /api/v1/sync/protocol/run   手动触发一轮同步（publish + consume）
 */

import { Hono } from 'hono'
import { protocolStatus, syncNow } from '../sync/protocolManager'

const syncProtocol = new Hono()

syncProtocol.get('/', (c) => {
  return c.json(protocolStatus())
})

syncProtocol.post('/run', async (c) => {
  try {
    const result = await syncNow()
    return c.json({ ok: true, ...result, status: protocolStatus() })
  } catch (e) {
    const code = (e as { code?: string }).code
    const status = code === 'not_configured' ? 503 : code === 'sync_in_progress' ? 409 : 500
    return c.json(
      { error: code ?? 'sync_error', message: e instanceof Error ? e.message : String(e) },
      status,
    )
  }
})

export default syncProtocol
