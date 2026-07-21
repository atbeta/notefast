import type { Context } from 'hono'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { registerMcpTools } from './tools'

const SESSION_TTL_MS = 30 * 60_000 // 30 分钟无活动自动清理

interface SessionEntry {
  transport: WebStandardStreamableHTTPServerTransport
  createdAt: number
}

const sessions = new Map<string, SessionEntry>()

export async function createSession(notebookId: string): Promise<{
  sid: string
  transport: WebStandardStreamableHTTPServerTransport
}> {
  const serverName = process.env.MCP_SERVER_NAME || 'notefast'
  const sid = crypto.randomUUID()

  const server = new McpServer(
    { name: serverName, version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} } },
  )
  registerMcpTools(server, notebookId)

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => sid,
  })
  await server.connect(transport)

  sessions.set(sid, { transport, createdAt: Date.now() })
  return { sid, transport }
}

function cleanupStale(): void {
  const now = Date.now()
  for (const [sid, entry] of sessions) {
    if (now - entry.createdAt > SESSION_TTL_MS) sessions.delete(sid)
  }
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

  // GET/DELETE：若无 SID 自动建，补 header 后转发
  if (httpMethod !== 'POST') {
    if (!sid) {
      const s = await createSession(notebookId)
      const h = new Headers(c.req.raw.headers)
      h.set('mcp-session-id', s.sid)
      return s.transport.handleRequest(new Request(c.req.raw.url, { method: httpMethod, headers: h }))
    }
    return c.json({ error: 'invalid_session' } as Record<string, unknown>, 400)
  }

  // POST：读 body 区分 initialize / tools/call
  const bodyText = await c.req.raw.text()
  let rpcMethod: string | null = null
  try { rpcMethod = (JSON.parse(bodyText || '{}') as { method?: string }).method ?? null } catch { /* empty */ }

  const autoInit = !sid || rpcMethod === 'initialize' || rpcMethod === 'tools/call' || !rpcMethod

  if (!autoInit) {
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Mcp-Session-Id required' }, id: null }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )
  }

  const session = await createSession(notebookId)

  // tools/call 等非 init 请求需先隐式 initialize 一把
  if (rpcMethod && rpcMethod !== 'initialize' && rpcMethod !== 'notifications/initialized') {
    const initH = new Headers()
    initH.set('content-type', 'application/json')
    initH.set('accept', 'application/json, text/event-stream')
    initH.set('mcp-session-id', session.sid)
    await session.transport.handleRequest(new Request(c.req.raw.url, {
      method: 'POST',
      headers: initH,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'auto-init', version: '1.0' } },
      }),
    }))
  }

  // SDK validateSession 要求请求头含 mcp-session-id
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