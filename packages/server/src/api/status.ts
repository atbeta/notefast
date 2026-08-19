import { Hono } from 'hono'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { hasRuntime } from '../services/aiRuntime'

const status = new Hono()

status.get('/', (c) => {
  const dataDir = process.env.DATA_DIR || './data'
  const hasAiConfig = existsSync(join(dataDir, 'ai.config.json'))
  const hasAuth = !!(process.env.AUTH_PASSWORD || '').trim()
  const hasToken = !!(process.env.API_TOKEN || '').trim()
  // first_run 保留在响应里（/api/v1 只做加法）；Web 已不再据此弹欢迎框
  const firstRun = !hasAiConfig && !hasAuth && !hasToken

  return c.json({
    first_run: firstRun,
    ai_configured: hasRuntime(),
  })
})

export default status
