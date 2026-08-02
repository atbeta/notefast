/**
 * 多端同步 API（双向增量同步，独立于「数据库备份」）
 *
 * 路由：
 * - GET    /api/v1/sync/protocol       状态（configured / state / lastRun）
 * - GET    /api/v1/sync/protocol/config 独立配置（密钥脱敏）
 * - PUT    /api/v1/sync/protocol/config 保存独立配置（enabled + s3）
 * - DELETE /api/v1/sync/protocol/config 停用多端同步
 * - POST   /api/v1/sync/protocol/run    手动触发一轮同步（publish + consume）
 * - POST   /api/v1/sync/protocol/pull   消费端拉取（恢复）
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { syncProtocolConfigSchema } from '@notefast/core'
import {
  applyProtocolManagerConfig,
  disableProtocolManager,
  protocolStatus,
  syncNow,
  syncPull,
} from '../sync/protocolManager'
import { getProtocolConfig, getProtocolPublicConfig } from '../sync/protocolConfig'

const syncProtocol = new Hono()

syncProtocol.get('/', (c) => {
  return c.json(protocolStatus())
})

syncProtocol.get('/config', (c) => {
  return c.json({
    configured: protocolStatus().configured,
    config: getProtocolPublicConfig(),
    status: protocolStatus(),
  })
})

syncProtocol.put('/config', zValidator('json', syncProtocolConfigSchema), async (c) => {
  const body = c.req.valid('json')
  const status = await applyProtocolManagerConfig({
    version: 1,
    enabled: body.enabled,
    s3: body.s3 ?? getProtocolConfig().s3,
  })
  return c.json({ ok: true, status, config: getProtocolPublicConfig() })
})

syncProtocol.delete('/config', async (c) => {
  const status = await disableProtocolManager()
  return c.json({ ok: true, status })
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

/** 消费端拉取：客户端从 S3 恢复数据到本地（首次全量 / 增量合并 + media） */
syncProtocol.post('/pull', async (c) => {
  try {
    const result = await syncPull()
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
