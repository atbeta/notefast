import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { initDb, closeDb } from './db'
import { authMiddleware } from './middleware/auth'
import { createMcpTransport } from './mcp/server'
import blocks from './api/blocks'
import docs from './api/docs'
import search from './api/search'
import importRouter from './api/import'
import refs from './api/refs'
import notebooks from './api/notebooks'

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

app.route('/api/v1/blocks', blocks)
app.route('/api/v1/docs', docs)
app.route('/api/v1/search', search)
app.route('/api/v1/import', importRouter)
app.route('/api/v1/refs', refs)

app.route('/api/v1/notebooks', notebooks)

const mcpTransport = await createMcpTransport(notebookId)

app.all('/mcp', authMiddleware, async (c) => {
  return mcpTransport.handleRequest(c.req.raw)
})

console.log(`🚀 NoteFast Server running at http://localhost:${PORT}`)
console.log(`📦 Default notebook: ${notebookId}`)
console.log(`🔧 MCP endpoint: http://localhost:${PORT}/mcp`)

export default {
  port: PORT,
  fetch: app.fetch,
}
