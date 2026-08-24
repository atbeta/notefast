import type { Context, Next, MiddlewareHandler } from 'hono'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { verifyToken, updateLastUsed } from '../services/apiTokens'

/** 会话 cookie 名（<img> 等无法带 Authorization 头的场景使用） */
export const SESSION_COOKIE = 'nf_sess'

declare module 'hono' {
  interface ContextVariableMap {
    authScopes: string[]
  }
}

/**
 * 会话 token 值：HMAC_SHA256(key=AUTH_PASSWORD, msg=固定串)。
 * 证明「知道密码」但不包含密码本身；服务端零状态（无需存 session 表），
 * 改密码后所有旧 cookie 自然失效。
 */
export function sessionTokenValue(): string {
  const pw = safeTrim(process.env.AUTH_PASSWORD || '')
  if (!pw) return ''
  return createHmac('sha256', pw).update('notefast-asset-session:v1').digest('hex')
}

/** 从 Cookie 头解析 nf_sess 并校验（常量时间比较） */
function hasValidSessionCookie(cookieHeader: string | undefined): boolean {
  const expected = sessionTokenValue()
  if (!expected || !cookieHeader) return false
  const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([0-9a-f]{64})(?:;|$)`))
  if (!m) return false
  return safeEquals(m[1]!, expected)
}

/**
 * 鉴权机制：
 *
 * 单用户模式，两种鉴权方式可单独或同时启用：
 *
 * 1. API Token（API_TOKEN 环境变量）
 *    - 用于 MCP / API / 外部工具调用
 *    - 通过 Authorization: Bearer <token> 头传递
 *    - 仅接受 Header，不接受 URL query（避免泄露到日志）
 *
 * 2. 密码（AUTH_PASSWORD 环境变量）
 *    - 用于 Web UI 登录
 *    - 通过 Authorization: Basic YWRtaW46PHBhc3N3b3JkPg== 头传递
 *    - 用户名为 admin
 *
 * 两个环境变量都不设时：不做任何鉴权，所有请求直接放行（开发/内网部署模式）
 *
 * 安全：所有 secret 比较都用 crypto.timingSafeEqual（防 timing attack）；
 * 长度不同时先比较长度（同样耗时）再做常量时间比较。
 */

function safeTrim(s: string): string {
  return s.trim()
}

/**
 * 长度恒定的字符串比较。
 * - 两侧长度不同时：返回 false 但仍执行一次 dummy 比较以避免长度泄漏（虽然长度本身不是高敏感信息）
 * - 长度相同时：用 timingSafeEqual（按字节比较，常量时间）
 */
function safeEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) {
    // 长度不等：仍执行一次同长度 dummy 比较，确保早退路径也是常量时间
    const dummy = Buffer.alloc(Math.max(a.length, b.length))
    timingSafeEqual(dummy, dummy)
    return false
  }
  return timingSafeEqual(a, b)
}

export function isAuthEnabled(): boolean {
  const apiToken = safeTrim(process.env.API_TOKEN || '')
  const authPassword = safeTrim(process.env.AUTH_PASSWORD || '')
  const readToken = safeTrim(process.env.READ_TOKEN || '')
  const writeToken = safeTrim(process.env.WRITE_TOKEN || '')
  return apiToken.length > 0 || authPassword.length > 0 || readToken.length > 0 || writeToken.length > 0
}

export const authMiddleware: MiddlewareHandler = async (c: Context, next: Next) => {
  if (c.req.path === '/api/v1/auth/mode') {
    await next()
    return
  }

  const apiToken = safeTrim(process.env.API_TOKEN || '')
  const readToken = safeTrim(process.env.READ_TOKEN || '')
  const writeToken = safeTrim(process.env.WRITE_TOKEN || '')
  const authPassword = safeTrim(process.env.AUTH_PASSWORD || '')

  if (apiToken.length === 0 && readToken.length === 0 && writeToken.length === 0 && authPassword.length === 0) {
    c.set('authScopes', ['admin'])
    await next()
    return
  }

  const authHeader = (c.req.header('Authorization') || '').trim()

  // Bearer 鉴权：
  //   如果设了 WRITE_TOKEN/READ_TOKEN 其中一个，则按方法拆分鉴权：
  //     POST/PATCH/PUT/DELETE → WRITE_TOKEN (仅该 token 可写)
  //     GET/HEAD              → READ_TOKEN  (仅该 token 可读)
  //   如果 WRITE_TOKEN 未设但 API_TOKEN 已设 → 写操作 fallback 到 API_TOKEN
  //   如果 READ_TOKEN 未设但 API_TOKEN 已设   → 读操作 fallback 到 API_TOKEN
  //   没有任何 token 设过 → 鉴权不启用
  //   注意：同时设 WRITE_TOKEN + API_TOKEN 时，API_TOKEN 不再拥有写权限
  //         （这是有意行为：切到 split 模式后旧的全能 token 必须收窄）
  //
  //   特例 /mcp：MCP 工具调用全是 POST，按 HTTP 方法拆权限会让只读 token
  //   连 notefast_search 都 403。因此 /mcp 不按方法一刀切，改按凭证角色
  //   推导 scopes，写工具的门禁下沉到工具层（mcp/tools/helpers.ts）：
  //     命中 WRITE_TOKEN                       → ['admin']
  //     命中 API_TOKEN，未设 WRITE_TOKEN        → ['admin']
  //     命中 API_TOKEN，已设 WRITE_TOKEN（收窄）→ ['read']
  //     命中 READ_TOKEN                        → ['read']
  //   非 /mcp 路径行为不变。
  const isMcp = c.req.path === '/mcp'
  const isWrite = c.req.method === 'POST' || c.req.method === 'PATCH' || c.req.method === 'PUT' || c.req.method === 'DELETE'

  if (isMcp && (apiToken.length > 0 || readToken.length > 0 || writeToken.length > 0)) {
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i)
    if (bearerMatch) {
      const provided = bearerMatch[1]!
      if (writeToken.length > 0 && safeEquals(provided, writeToken)) {
        c.set('authScopes', ['admin'])
        await next()
        return
      }
      if (apiToken.length > 0 && safeEquals(provided, apiToken)) {
        c.set('authScopes', writeToken.length > 0 ? ['read'] : ['admin'])
        await next()
        return
      }
      if (readToken.length > 0 && safeEquals(provided, readToken)) {
        c.set('authScopes', ['read'])
        await next()
        return
      }
    }
  }

  const effectiveToken = isWrite
    ? (writeToken || apiToken)
    : (readToken || apiToken)

  if (!isMcp && effectiveToken.length > 0) {
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i)
    if (bearerMatch && safeEquals(bearerMatch[1]!, effectiveToken)) {
      c.set('authScopes', ['admin'])
      await next()
      return
    }
  }

  // 非 env token：查 api_tokens 表
  if (apiToken.length > 0 || readToken.length > 0 || writeToken.length > 0 || authPassword.length > 0) {
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i)
    if (bearerMatch) {
      const record = verifyToken(bearerMatch[1]!)
      if (record) {
        // scopes 列若被写坏（历史数据/直接 SQL），拒绝该 token（401）而不是炸 500
        let scopes: string[] | null = null
        try {
          const parsed: unknown = JSON.parse(record.scopes)
          if (Array.isArray(parsed)) scopes = parsed.filter((s): s is string => typeof s === 'string')
        } catch { /* scopes 保持 null，落到底部 401 */ }
        if (scopes) {
          c.set('authScopes', scopes)
          // write scope 强制：api_tokens 表签发的 token 按 scopes 收窄写操作
          // （此前仅 /api-tokens 管理端点查 scope，read-only token 也能写全库）。
          // admin（web-session）与显式 write 放行；env API_TOKEN / api.key / 免鉴权 /
          // trustedLocal 均在上方分支以 admin 直通，不受此检查影响。
          // /mcp 例外：MCP 全是 POST，写权限由工具层按 annotations.readOnlyHint 门禁，
          // 这里放行进会话（session 绑定此处推导的 scopes）。
          if (isWrite && !isMcp && !requireScope(c, 'write')) {
            return c.json({ error: 'forbidden', message: '该 Token 为只读（scopes 缺少 write），无法执行写操作' }, 403)
          }
          // fire-and-forget 更新 last_used_at
          try { updateLastUsed(record.token_id) } catch { /* ignore */ }
          await next()
          return
        }
      }
    }
  }

  if (authPassword.length > 0) {
    const basicMatch = authHeader.match(/^Basic\s+(.+)$/i)
    if (basicMatch) {
      try {
        const decoded = atob(basicMatch[1]!)
        const colonIdx = decoded.indexOf(':')
        if (colonIdx > 0) {
          const user = decoded.slice(0, colonIdx)
          const pass = decoded.slice(colonIdx + 1)
          if (user === 'admin' && safeEquals(pass, authPassword)) {
            c.set('authScopes', ['admin'])
            await next()
            return
          }
        }
      } catch {
        // atob 解码失败，丢弃请求
      }
    }

    // 会话 cookie（<img>/<video> 等无法携带 Authorization 头的读取场景，仅放行读操作）
    if (!isWrite && hasValidSessionCookie(c.req.header('Cookie'))) {
      c.set('authScopes', ['admin'])
      await next()
      return
    }
  }

  return c.json(
    {
      error: 'unauthorized',
      message: '需要有效的 API Token 或密码',
      hint: '使用 Authorization: Bearer <token> 或 Authorization: Basic YWRtaW46PHBhc3N3b3JkPg==',
    },
    401,
  )
}

export function readScopes(c: Context): string[] {
  return c.get('authScopes') ?? []
}

export function requireScope(c: Context, scope: string): boolean {
  return readScopes(c).includes(scope) || readScopes(c).includes('admin')
}
