import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { createPluginSystem } from '@notefast/core'
import { initDb, closeDb } from './db'
import { authMiddleware } from './middleware/auth'
import { handleMcpRequest } from './mcp/server'
import { startAutoExport } from './services/autoExport'
import { initAiRuntime } from './services/aiRuntime'
import { initSyncManager } from './sync/manager'
import { initVectorStore } from './ai/indexer'
import blocks from './api/blocks'
import docs from './api/docs'
import search from './api/search'
import importRouter from './api/import'
import refs from './api/refs'
import notebooks from './api/notebooks'
import sync from './api/sync'
import ai from './api/ai'
import autoLink from './api/autoLink'
import tags from './api/tags'

const PORT = parseInt(process.env.PORT || '3140', 10)
const DATA_DIR = process.env.DATA_DIR || './data'

const { notebookId } = initDb(DATA_DIR)

process.on('exit', () => closeDb())
process.on('SIGINT', () => { closeDb(); process.exit(0) })
process.on('SIGTERM', () => { closeDb(); process.exit(0) })

const app = new Hono()

app.use('*', cors({
  origin: (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map(s => s.trim()),
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

app.use('/api/*', authMiddleware)

app.get('/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }))

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
app.route('/api/v1/ai', ai)
app.route('/api/v1/auto-link', autoLink)
app.route('/api/v1/tags', tags)

const pluginSystem = createPluginSystem()

initVectorStore()
initSyncManager(DATA_DIR)
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

export default {
  port: PORT,
  host: '0.0.0.0',
  fetch: app.fetch,
}
