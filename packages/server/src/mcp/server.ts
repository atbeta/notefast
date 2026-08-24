import type { Context } from 'hono'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { registerMcpTools } from './tools'

const SESSION_TTL_MS = 30 * 60_000 // 30 分钟无活动自动清理
const MAX_SESSIONS = 1000 // 防止 OOM DoS

interface SessionEntry {
  transport: WebStandardStreamableHTTPServerTransport
  createdAt: number
  /**
   * 会话绑定创建者的 authScopes（如 ['read'] / ['admin']），写工具门禁按此判定。
   * 语义：scopes 在会话建立时快照，30 分钟 TTL 内不随 token 撤销/改权变化
   * （token 失效只影响新会话；要立刻收权需重启服务清会话）。
   */
  scopes: string[]
}

const sessions = new Map<string, SessionEntry>()

export async function createSession(notebookId: string, scopes: string[] = ['admin']): Promise<{
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
  registerMcpTools(server, notebookId, scopes)

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

  sessions.set(sid, { transport, createdAt: Date.now(), scopes })
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

/**
 * JSON-RPC 2.0 信封合规校验；返回错误消息（null = 合规）。
 * 仅查信封形状，不查 method 是否存在（那是 -32601，由 SDK Protocol 层处理）。
 */
function validateJsonRpcEnvelope(v: unknown): string | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return 'Invalid Request: expected a single JSON-RPC object'
  }
  const m = v as Record<string, unknown>
  if (m.jsonrpc !== '2.0') {
    return `Invalid Request: jsonrpc must be "2.0", got ${JSON.stringify(m.jsonrpc ?? null)}`
  }
  if (!('method' in m)) {
    return 'Invalid Request: missing method'
  }
  if (typeof m.method !== 'string') {
    return 'Invalid Request: method must be a string'
  }
  if ('id' in m && m.id !== null && typeof m.id !== 'string' && typeof m.id !== 'number') {
    return 'Invalid Request: id must be string, number or null'
  }
  return null
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

  // authMiddleware 推导的凭证 scopes（/mcp 按凭证角色而非 HTTP 方法拆分）；
  // 未经中间件的直连（测试）缺省 [] = 只读，写工具会被工具层门禁拒绝
  const scopes = c.get('authScopes') ?? []

  const sid = c.req.header('mcp-session-id')
  if (sid && sessions.has(sid)) {
    const entry = sessions.get(sid)!
    entry.createdAt = Date.now()
    return entry.transport.handleRequest(c.req.raw)
  }

  const httpMethod = c.req.method

  if (httpMethod !== 'POST') {
    if (!sid) {
      const s = await createSession(notebookId, scopes)
      const h = new Headers(c.req.raw.headers)
      h.set('mcp-session-id', s.sid)
      ensureCleanupTimer()
      return s.transport.handleRequest(new Request(c.req.raw.url, { method: httpMethod, headers: h }))
    }
    return c.json({ error: 'invalid_session' } as Record<string, unknown>, 400)
  }

  const bodyText = await c.req.raw.text()

  // JSON-RPC 信封预检（spec 合规）：SDK 的 transport 把所有不合规请求一律报
  // -32700 Parse error；按 JSON-RPC 2.0 规范——只有 JSON 语法错误才是 -32700，
  // 信封不合规（缺 jsonrpc、版本不对、method/id 类型错）应该是 -32600。
  let rpcBody: unknown
  let parseFailed = false
  try {
    rpcBody = JSON.parse(bodyText)
  } catch {
    parseFailed = true
  }
  if (parseFailed) {
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: Invalid JSON' }, id: null }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )
  }
  const envelopeError = validateJsonRpcEnvelope(rpcBody)
  if (envelopeError) {
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: envelopeError }, id: null }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )
  }

  const rpcMethod = (rpcBody as { method?: string }).method ?? null

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

  const session = await createSession(notebookId, scopes)
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