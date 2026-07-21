import type { Context } from 'hono'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { registerMcpTools } from './tools'

const SESSION_TTL_MS = 30 * 60_000 // 30 分钟无活动自动清理
const MAX_SESSIONS = 1000 // 防止 OOM DoS

interface SessionEntry {
  transport: WebStandardStreamableHTTPServerTransport
  createdAt: number
}

const sessions = new Map<string, SessionEntry>()

export async function createSession(notebookId: string): Promise<{
  sid: string
  transport: WebStandardStreamableHTTPServerTransport
}> {
  cleanupStale()
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error('Too many active MCP sessions')
  }

  const serverName = process.env.MCP_SERVER_NAME || 'notefast'
  const sid = crypto.randomUUID()

  const server = new McpServer(
    { name: serverName, version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} } },
  )
  registerMcpTools(server, notebookId)

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => sid,
    onsessionclosed: () => { sessions.delete(sid) },
  })
  await server.connect(transport)

  // 工具集在进程生命周期内是静态的（无运行时增删），如实声明 listChanged: false，
  // 客户端按需轮询 tools/list 即可。SDK 在 connect 时会强制注册 listChanged: true
  // （registerCapabilities 合并），只能在 connect 后把声明改回来。
  const caps = (server as unknown as {
    server: { _capabilities: { tools?: { listChanged?: boolean }; resources?: { listChanged?: boolean } } }
  }).server._capabilities
  if (caps.tools) caps.tools.listChanged = false
  if (caps.resources) caps.resources.listChanged = false

  sessions.set(sid, { transport, createdAt: Date.now() })
  return { sid, transport }
}

function cleanupStale(): void {
  const now = Date.now()
  for (const [sid, entry] of sessions) {
    if (now - entry.createdAt > SESSION_TTL_MS) {
      entry.transport.close().catch(() => {})
      sessions.delete(sid)
    }
  }
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null

function ensureCleanupTimer(): void {
  if (cleanupTimer !== null) return
  cleanupTimer = setInterval(() => {
    cleanupStale()
    if (sessions.size === 0 && cleanupTimer !== null) {
      clearInterval(cleanupTimer)
      cleanupTimer = null
    }
  }, 60_000)
}

export async function handleMcpRequest(notebookId: string, c: Context): Promise<Response> {
  cleanupStale()

  const sid = c.req.header('mcp-session-id')
  if (sid && sessions.has(sid)) {
    const entry = sessions.get(sid)!
    entry.createdAt = Date.now()
    return entry.transport.handleRequest(c.req.raw)
  }

  const httpMethod = c.req.method

  if (httpMethod !== 'POST') {
    if (!sid) {
      const s = await createSession(notebookId)
      const h = new Headers(c.req.raw.headers)
      h.set('mcp-session-id', s.sid)
      ensureCleanupTimer()
      return s.transport.handleRequest(new Request(c.req.raw.url, { method: httpMethod, headers: h }))
    }
    return c.json({ error: 'invalid_session' } as Record<string, unknown>, 400)
  }

  const bodyText = await c.req.raw.text()
  let rpcMethod: string | null = null
  try { rpcMethod = (JSON.parse(bodyText || '{}') as { method?: string }).method ?? null } catch { /* empty */ }

  const autoInit = !sid && rpcMethod === 'initialize'

  if (!autoInit) {
    if (!sid) {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Mcp-Session-Id required. Send initialize first or include header.' }, id: null }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session expired or not found' }, id: null }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    )
  }

  const session = await createSession(notebookId)
  ensureCleanupTimer()

  const rewrapped = new Headers(c.req.raw.headers)
  rewrapped.set('mcp-session-id', session.sid)
  const response = await session.transport.handleRequest(new Request(c.req.raw.url, {
    method: 'POST',
    headers: rewrapped,
    body: bodyText,
  }))

  if (!response.headers.has('mcp-session-id')) {
    const h = new Headers(response.headers)
    h.set('mcp-session-id', session.sid)
    return new Response(response.body, { status: response.status, headers: h })
  }
  return response
}