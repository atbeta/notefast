/**
 * NoteFast Server 程序化入口（库化）
 *
 * createApp() 返回一个可被任意宿主复用的 Hono app + 生命周期句柄：
 * - web CLI / Docker 走 index.ts（Bun.serve + 信号处理）
 * - 原生客户端可内嵌：createApp(dataDir) → 直接 app.fetch() 或自建 Bun.serve
 *
 * 设计：
 * - createApp 只做「构造」，不做任何副作用（不 init DB、不建索引）
 * - start() 做全部数据层初始化（幂等）；stop() 做清理（幂等）
 * - 环境变量读取与旧 index.ts 一致（PORT/CORS/WEB_DIST/AUTO_EXPORT_DIR 等），
 *   但 dataDir 显式传入而非只读 env —— 原生端可指定任意目录
 */

import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import type { Server } from 'bun'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPluginSystem, safeLogWarn } from '@notefast/core'
import { createWebSessionToken, revokeWebSessionTokens } from './services/apiTokens'
import { initDb, closeDb, getDb } from './db'
import { authMiddleware, SESSION_COOKIE, sessionTokenValue } from './middleware/auth'
import { createRateLimit } from './middleware/rateLimit'
import { emitAppEvent } from './events'
import { handleMcpRequest } from './mcp/server'
import { registerMcpTools } from './mcp/tools'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { startAutoExport } from './services/autoExport'
import { initAiRuntime } from './services/aiRuntime'
import { initSyncManager } from './sync/manager'
import { initProtocolManager } from './sync/protocolManager'
import { initBackupManager, stopBackupManager } from './backup/manager'
import { initStorageLocations } from './storage/locations'
import { initPreferences } from './api/preferences'
import { initTermDict } from './termDict'
import { initVectorStore } from './ai/indexer'
import { initAssetStore, setImageUploadConfig } from './assets/store'
import { initImageUploadConfig } from './services/imageUploadConfig'
import { getVectorStore } from './ai/vectorStore'
import blocks from './api/blocks'
import docs from './api/docs'
import search from './api/search'
import importRouter from './api/import'
import exportArchive from './api/exportArchive'
import refs from './api/refs'
import notebooks from './api/notebooks'
import sync from './api/sync'
import backup from './api/backup'
import ai from './api/ai'
import autoLink from './api/autoLink'
import entities, { docEntities } from './api/entities'
import graph from './api/graph'
import tags from './api/tags'
import assets from './api/assets'
import apiTokens from './api/apiTokens'
import pinnedViews from './api/pinnedViews'
import preferences from './api/preferences'
import statusRouter from './api/status'
import mcpRouter from './api/mcp'
import termDict from './api/termDict'
import eventsRouter from './api/events'
import syncProtocolRouter from './api/syncProtocol'
import clientErrors from './api/clientErrors'
import { initClientErrors } from './api/clientErrors'
import storageLocations from './api/storageLocations'
import sharePublic from './api/sharePublic'
import { initDocEvents } from './services/docEvents'
import { startEntityDescribe } from './ai/entityDescribe'

export interface NoteFastServer {
  /** Hono app（未 serve 的纯处理器；可直接 app.fetch(req) 或自建 Bun.serve） */
  app: Hono
  /** 默认 notebook id（start() 后可用） */
  notebookId: string
  /** 实例版本号（与旧 index.ts 同源：APP_VERSION env 或 package.json） */
  version: string
  /** 数据层初始化（幂等）；返回 this 便于链式 */
  start(): Promise<NoteFastServer>
  /** 清理（幂等）：停备份/关 DB；不退出进程 */
  stop(): Promise<void>
  /** 由宿主在 Bun.serve 后注入，用于 SSE idleTimeout 放宽 */
  attachServer(server: Server<undefined>): void
}
export interface CreateAppOptions {
  /** 数据目录（SQLite + media + 配置）；缺省读 DATA_DIR env */
  dataDir?: string
  /** 是否允许「本地免鉴权」——仅监听 127.0.0.1 或原生内嵌场景，跳过 token/密码校验 */
  trustedLocal?: boolean
}

/** True if the request originates from the local loopback (no proxy headers set).
 *  反代场景下 X-Forwarded-For / CF-Connecting-IP 任一非空即视为非本地，不信任。 */
function isLoopbackRequest(c: Context): boolean {
  return !c.req.header('x-forwarded-for')?.trim() && !c.req.header('cf-connecting-ip')?.trim()
}

export function createApp(opts: CreateAppOptions = {}): NoteFastServer {
  const dataDir = opts.dataDir || process.env.DATA_DIR || './data'

  let started = false
  let notebookId = ''
  let serverRef: Server<undefined> | null = null
  let exportStarted = false

  const app = new Hono()

  // ───────────────────── 中间件 ─────────────────────
  // CORS_ORIGINS：逗号分隔的精确匹配列表；任一项为字面 * 时放行任意 origin
  // （hono cors 的数组是精确匹配，['*'] 不等于通配，必须传字符串 '*'）。
  // 安全警示：免鉴权模式 + '*' 意味着任意网页可读写整个库，生产环境切勿使用。
  const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map((s) => s.trim())
  app.use('*', cors({
    origin: corsOrigins.includes('*') ? '*' : corsOrigins,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }))

  const rateLimit = createRateLimit()
  if (rateLimit) app.use('*', rateLimit)

  // 本地免鉴权通道：原生内嵌 / 仅本机回环时，跳过 token/密码校验（走 admin）。
  // 在 authMiddleware 之前注册（auth 内部也已对未配置鉴权全放行；此分支覆盖「配置了但本地信任」场景）
  const localTrust: MiddlewareHandler = async (c, next) => {
    if (opts.trustedLocal && isLoopbackRequest(c)) {
      c.set('authScopes', ['admin'])
    }
    return next()
  }
  app.use('/api/*', localTrust)
  app.use('/api/*', authMiddleware)

  // SSE 长连接路由：单独放宽 idleTimeout（server.timeout 是 per-request 的）。
  // 注意：必须注册在任何 app.route() 之前（Hono 按注册顺序执行，放路由后 = 死代码）。
  const SSE_IDLE_TIMEOUT_S = 60
  const relaxSseIdleTimeout: MiddlewareHandler = (c, next) => {
    serverRef?.timeout(c.req.raw, SSE_IDLE_TIMEOUT_S)
    return next()
  }
  app.use('/api/v1/events', relaxSseIdleTimeout)
  app.use('/api/v1/ai/chat', relaxSseIdleTimeout)
  app.use('/api/v1/ai/write', relaxSseIdleTimeout)

  // ───────────────────── 基础路由 ─────────────────────
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
    return c.json({ status: 'ok', time: new Date().toISOString(), vectorStore: status })
  })

  // 实例版本号：APP_VERSION env 或 package.json（src 与 dist 均为其同级子目录）
  let version = (process.env.APP_VERSION || '').trim().replace(/^v/, '')
  if (!version) {
    version = '0.0.0'
    try {
      const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'))
      if (typeof pkg.version === 'string' && pkg.version) version = pkg.version
    } catch { /* 保持兜底 */ }
  }

  app.get('/api/v1/version', (c) => c.json({ version }))

  // Web 登录 / 登出 / 鉴权模式探测 / 登录审计
  app.post('/api/v1/auth/session', (c) => {
    const token = sessionTokenValue()
    if (!token) return c.json({ session: false })
    const remember = c.req.query('remember') !== '0'
    const maxAge = remember ? '; Max-Age=604800' : ''
    const secure = c.req.url.startsWith('https://') || c.req.header('x-forwarded-proto') === 'https'
      ? '; Secure'
      : ''
    c.header('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${maxAge}${secure}`)

    const session = createWebSessionToken(remember)

    try {
      const ip = c.req.header('cf-connecting-ip')
        || c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
        || c.req.header('x-real-ip')
        || null
      const ua = c.req.header('user-agent') ?? ''
      getDb().query(
        'INSERT INTO auth_events (id, event_type, ip, user_agent) VALUES (?, ?, ?, ?)',
      ).run(crypto.randomUUID(), 'login', ip, ua)
      getDb().query(
        'DELETE FROM auth_events WHERE id NOT IN (SELECT id FROM auth_events ORDER BY created_at DESC LIMIT 1000)',
      ).run()
    } catch (e) { safeLogWarn('auth_events.write_failed', { error: String(e) }) }

    return c.json({ session: true, token: session.plain })
  })

  app.delete('/api/v1/auth/session', (c) => {
    revokeWebSessionTokens()
    c.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`)
    return c.json({ session: false })
  })

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

  app.get('/api/v1/auth/events', (c) => {
    try {
      const rows = getDb().query(
        'SELECT id, event_type, ip, user_agent, created_at FROM auth_events ORDER BY created_at DESC LIMIT 30',
      ).all() as Array<{ id: string; event_type: string; ip: string | null; user_agent: string | null; created_at: string }>
      return c.json(rows)
    } catch (e) {
      safeLogWarn('auth_events.read_failed', { error: String(e) })
      return c.json([])
    }
  })

  // ───────────────────── 业务路由 ─────────────────────
  app.route('/api/v1/blocks', blocks)
  app.route('/api/v1/docs', docs)
  app.route('/api/v1/search', search)
  app.route('/api/v1/import', importRouter)
  app.route('/api/v1/export', exportArchive)
  app.route('/api/v1/refs', refs)
  app.route('/api/v1/notebooks', notebooks)
  app.route('/api/v1/sync', sync)
  app.route('/api/v1/backup', backup)
  app.route('/api/v1/storage-locations', storageLocations)
  app.route('/api/v1/ai', ai)
  app.route('/api/v1/auto-link', autoLink)
  app.route('/api/v1/entities', entities)
  app.route('/api/v1/graph', graph)
  app.route('/api/v1/docs', docEntities)
  app.route('/api/v1/tags', tags)
  app.route('/api/v1/assets', assets)
  app.route('/api/v1/api-tokens', apiTokens)
  app.route('/api/v1/pinned-views', pinnedViews)
  app.route('/api/v1/preferences', preferences)
  app.route('/api/v1/status', statusRouter)
  app.route('/api/v1/term-dict', termDict)
  app.route('/api/v1/mcp', mcpRouter)
  app.route('/api/v1/events', eventsRouter)
  app.route('/api/v1/sync/protocol', syncProtocolRouter)
  app.route('/api/v1/client-errors', clientErrors)

  // 分享页防 iframe 嵌入/点击劫持：中间件必须先于 app.route 注册
  // （Hono 按注册顺序执行，放路由后 = 死代码，响应拿不到安全头）
  const denyFraming: MiddlewareHandler = async (c, next) => {
    await next()
    c.header('X-Frame-Options', 'DENY')
    c.header('Content-Security-Policy', "frame-ancestors 'none'")
  }
  app.use('/s/*', denyFraming)
  app.use('/share/*', denyFraming)

  // 分享公开端点：挂在 /api/* 之外，无需鉴权
  app.route('/share', sharePublic)

  const pluginSystem = createPluginSystem()

  // ───────────────────── 生命周期 ─────────────────────
  const start = async (): Promise<NoteFastServer> => {
    if (started) return handle
    started = true

    const { notebookId: nb } = initDb(dataDir)
    notebookId = nb
    process.on('exit', () => { stopBackupManager(); closeDb() })

    initDocEvents(pluginSystem)
    await initVectorStore()
    initAssetStore(dataDir)
    // 图床上传配置：init 后注入 assets 存储层（异步上传命令契约）
    setImageUploadConfig(initImageUploadConfig(dataDir))
    initStorageLocations(dataDir)
    initPreferences(dataDir)
    initClientErrors()
    initSyncManager(dataDir)
    initBackupManager(dataDir)
    initProtocolManager(dataDir)
    initAiRuntime(pluginSystem, dataDir)
    initTermDict(dataDir)
    startEntityDescribe()

    // MCP 工具注册表预填充：真实 SDK 注册在首次 MCP 会话时（createSession 懒加载），
    // 但设置页 /api/v1/mcp/tools 需要启动即有数据；重复注册幂等（reset + 重推）
    registerMcpTools(
      new McpServer({ name: 'notefast', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } }),
      notebookId,
    )

    app.all('/mcp', authMiddleware, async (c) => {
      return handleMcpRequest(notebookId, c)
    })

    const webDist = process.env.WEB_DIST || ''
    if (webDist) {
      app.use('/*', serveStatic({ root: webDist }))
      app.get('/*', serveStatic({ path: 'index.html', root: webDist }))
    }

    const exportDir = process.env.AUTO_EXPORT_DIR || ''
    if (exportDir) {
      startAutoExport(exportDir)
      exportStarted = true
      if (!process.env.SYNC_LOCAL_DIR) {
        console.log(`📁 Auto-export: ${exportDir}`)
      }
    }

    return handle
  }

  const stop = async (): Promise<void> => {
    if (!started) return
    started = false
    if (exportStarted) { /* autoExport 无 stop API；进程退出时自然清理 */ }
    try { stopBackupManager() } catch { /* ignore */ }
    try { closeDb() } catch { /* ignore */ }
  }

  const handle: NoteFastServer = {
    app,
    // start() 后才有值：用 getter 读 live 变量，而非创建时快照
    get notebookId() { return notebookId },
    version,
    start,
    stop,
    attachServer: (srv) => { serverRef = srv },
  }
  return handle
}
