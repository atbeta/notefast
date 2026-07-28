import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import type { Server } from 'bun'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPluginSystem } from '@notefast/core'
import { initDb, closeDb } from './db'
import { authMiddleware, isAuthEnabled, SESSION_COOKIE, sessionTokenValue } from './middleware/auth'
import { createRateLimit } from './middleware/rateLimit'
import { eventContextMiddleware } from './middleware/eventContext'
import { emitAppEvent } from './events'
import { handleMcpRequest } from './mcp/server'
import { startAutoExport } from './services/autoExport'
import { initAiRuntime } from './services/aiRuntime'
import { initSyncManager } from './sync/manager'
import { initBackupManager, stopBackupManager } from './backup/manager'
import { initVectorStore } from './ai/indexer'
import { initAssetStore } from './assets/store'
import { getVectorStore } from './ai/vectorStore'
import blocks from './api/blocks'
import docs from './api/docs'
import search from './api/search'
import importRouter from './api/import'
import refs from './api/refs'
import notebooks from './api/notebooks'
import sync from './api/sync'
import backup from './api/backup'
import ai from './api/ai'
import autoLink from './api/autoLink'
import tags from './api/tags'
import assets from './api/assets'
import apiTokens from './api/apiTokens'
import pinnedViews from './api/pinnedViews'
import statusRouter from './api/status'
import eventsRouter from './api/events'
import sharePublic from './api/sharePublic'
import { initDocEvents } from './services/docEvents'

const PORT = parseInt(process.env.PORT || '3140', 10)
const DATA_DIR = process.env.DATA_DIR || './data'

const { notebookId } = initDb(DATA_DIR)

process.on('exit', () => { stopBackupManager(); closeDb() })

const app = new Hono()

app.use('*', cors({
  origin: (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map(s => s.trim()),
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

const rateLimit = createRateLimit()
if (rateLimit) app.use('*', rateLimit)

app.use('/api/*', eventContextMiddleware)

app.use('/api/*', authMiddleware)

app.get('/health', async (c) => {
  const status = await getVectorStore().status()
  emitAppEvent({
    source: 'web',
    actor: 'system',
    action: 'health.check',
    outcome: 'success',
    durationMs: undefined,
    target: undefined,
  })
  return c.json({
    status: 'ok',
    time: new Date().toISOString(),
    vectorStore: status,
  })
})

// 实例版本号：Docker 部署取镜像构建时注入的 APP_VERSION（= git tag），
// 否则回退读 packages/server/package.json（src 与打包后的 dist 均为其同级子目录）。
// Web 侧边栏据此动态展示，升级版本时无需改前端。
let appVersion = (process.env.APP_VERSION || '').trim().replace(/^v/, '')
if (!appVersion) {
  appVersion = '0.0.0'
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'))
    if (typeof pkg.version === 'string' && pkg.version) appVersion = pkg.version
  } catch { /* 读取失败保持兜底值 */ }
}

app.get('/api/v1/version', (c) => c.json({ version: appVersion }))

// Web 登录后建立会话 cookie：<img> 等无法携带 Authorization 头的读取场景用它鉴权。
// cookie 值 = HMAC(密码)，不含密码本身；remember=0 时为会话 cookie（关浏览器即失效）。
// HTTPS（直连或反代终止 TLS 经 X-Forwarded-Proto 传递）时加 Secure，防 HTTP 明文泄露。
app.post('/api/v1/auth/session', (c) => {
  const token = sessionTokenValue()
  if (!token) return c.json({ session: false })
  const remember = c.req.query('remember') !== '0'
  const maxAge = remember ? '; Max-Age=604800' : ''
  const secure = c.req.url.startsWith('https://') || c.req.header('x-forwarded-proto') === 'https'
    ? '; Secure'
    : ''
  c.header('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${maxAge}${secure}`)
  return c.json({ session: true })
})

// 鉴权模式探测：返回当前实例是否需要密码 / token。
// 放在 authMiddleware 之后注册路径（middleware 内部已对 /auth/mode 放行）。
app.get('/api/v1/auth/mode', (c) => {
  const read = (process.env.READ_TOKEN || '').trim()
  const write = (process.env.WRITE_TOKEN || '').trim()
  const api = (process.env.API_TOKEN || '').trim()
  const pw = (process.env.AUTH_PASSWORD || '').trim()
  return c.json({
    passwordRequired: pw.length > 0,
    tokenRequired: api.length > 0 || read.length > 0 || write.length > 0,
    tokenGranularity: read.length > 0 || write.length > 0 ? 'split' : api.length > 0 ? 'single' : 'none',
  })
})

app.route('/api/v1/blocks', blocks)
app.route('/api/v1/docs', docs)
app.route('/api/v1/search', search)
app.route('/api/v1/import', importRouter)
app.route('/api/v1/refs', refs)

app.route('/api/v1/notebooks', notebooks)
app.route('/api/v1/sync', sync)
app.route('/api/v1/backup', backup)
app.route('/api/v1/ai', ai)
app.route('/api/v1/auto-link', autoLink)
app.route('/api/v1/tags', tags)
app.route('/api/v1/assets', assets)
app.route('/api/v1/api-tokens', apiTokens)
app.route('/api/v1/pinned-views', pinnedViews)
app.route('/api/v1/status', statusRouter)
app.route('/api/v1/events', eventsRouter)

// SSE 长连接路由：单独放宽 idleTimeout（server.timeout 是 per-request 的）。
// 全局保持 Bun 默认 10s，避免普通 API 的 keep-alive socket 也被拖住 60s 占 fd。
// 60s 大于 events 心跳间隔（25s，margin 35s）与 chat ping（10s），健康连接由心跳保活。
let serverRef: Server<undefined> | null = null
const SSE_IDLE_TIMEOUT_S = 60
const relaxSseIdleTimeout: MiddlewareHandler = (c, next) => {
  serverRef?.timeout(c.req.raw, SSE_IDLE_TIMEOUT_S)
  return next()
}
app.use('/api/v1/events', relaxSseIdleTimeout)
app.use('/api/v1/ai/chat', relaxSseIdleTimeout)
app.use('/api/v1/ai/write', relaxSseIdleTimeout)

// 分享公开端点：挂在 /api/* 之外（authMiddleware 只覆盖 /api/*），无需鉴权
app.route('/share', sharePublic)

// 公开分享页（/s/*）与分享端点（/share/*）：禁止被 iframe 嵌入（防点击劫持）
const denyFraming: MiddlewareHandler = async (c, next) => {
  await next()
  c.header('X-Frame-Options', 'DENY')
  c.header('Content-Security-Policy', "frame-ancestors 'none'")
}
app.use('/s/*', denyFraming)
app.use('/share/*', denyFraming)

const pluginSystem = createPluginSystem()
initDocEvents(pluginSystem)

await initVectorStore()
initAssetStore(DATA_DIR)
initSyncManager(DATA_DIR)
initBackupManager(DATA_DIR)
initAiRuntime(pluginSystem, DATA_DIR)

app.all('/mcp', authMiddleware, async (c) => {
  return handleMcpRequest(notebookId, c)
})

const webDist = process.env.WEB_DIST || ''
if (webDist) {
  app.use('/*', serveStatic({ root: webDist }))
  app.get('/*', serveStatic({ path: 'index.html', root: webDist }))
}

console.log(`🚀 NoteFast Server running at http://localhost:${PORT}`)
console.log(`📦 Default notebook: ${notebookId}`)
console.log(`🔧 MCP endpoint: http://localhost:${PORT}/mcp`)

const exportDir = process.env.AUTO_EXPORT_DIR || ''
if (exportDir) {
  startAutoExport(exportDir)
  if (!process.env.SYNC_LOCAL_DIR) {
    console.log(`📁 Auto-export: ${exportDir}`)
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  fetch: app.fetch,
  // idleTimeout 保持 Bun 默认（10s）：普通 API 连接快速回收；
  // SSE 长连接由上面的 relaxSseIdleTimeout 中间件经 server.timeout 单独放宽
})
serverRef = server

// 未配置任何鉴权时所有请求以 admin 放行（本地开发便利设计）；
// 监听 0.0.0.0，误暴露到公网即全面失防——启动时醒目告警，不做静默放行
if (!isAuthEnabled()) {
  console.warn('⚠️  未配置任何鉴权（API_TOKEN / AUTH_PASSWORD / READ_TOKEN / WRITE_TOKEN）')
  console.warn('⚠️  所有 API/MCP 请求将以 admin 权限放行，仅适用于本地开发或可信内网')
  console.warn('⚠️  暴露到公网前请务必配置鉴权（见 .env.example）')
}

// 优雅停机：docker restart / systemd stop 的 SIGTERM 先停止接收新连接，
// 等在飞请求（写事务 / SSE / AI 流）drain 完再退出；超时强退，避免无限挂起
// （SSE 长连接本身不会自然结束，只能靠超时兜底）。
// SQLite 事务在 bun:sqlite 中是同步的，信号 handler 不会插在事务中间执行，
// drain 主要保护 async handler 的跨 await 写序列（sync push、备份、AI 调用）。
const SHUTDOWN_TIMEOUT_MS = 10_000
let shuttingDown = false
function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n🛑 收到 ${signal}，停止接收新连接，等待在飞请求完成…`)
  const forceTimer = setTimeout(() => {
    console.error(`⚠️ ${SHUTDOWN_TIMEOUT_MS}ms 内未能 drain，强制退出`)
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS)
  forceTimer.unref()
  // stop(false)：不再 accept，但等已建立的连接处理完；DB 清理由 exit handler 统一做
  void server.stop(false).then(() => {
    clearTimeout(forceTimer)
    process.exit(0)
  })
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
