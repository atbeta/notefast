import type { Context, Next, MiddlewareHandler } from 'hono'
import { timingSafeEqual } from 'node:crypto'

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
  return apiToken.length > 0 || authPassword.length > 0
}

export const authMiddleware: MiddlewareHandler = async (c: Context, next: Next) => {
  // 公开端点：Web UI 启动时探测当前实例是否需要密码 / token，
  // 必须在鉴权前放行，否则前端拿不到状态就锁死。
  if (c.req.path === '/api/v1/auth/mode') {
    await next()
    return
  }

  const apiToken = safeTrim(process.env.API_TOKEN || '')
  const authPassword = safeTrim(process.env.AUTH_PASSWORD || '')

  if (apiToken.length === 0 && authPassword.length === 0) {
    await next()
    return
  }

  const authHeader = (c.req.header('Authorization') || '').trim()

  if (apiToken.length > 0) {
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i)
    if (bearerMatch && safeEquals(bearerMatch[1]!, apiToken)) {
      await next()
      return
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
            await next()
            return
          }
        }
      } catch {
        // atob 解码失败，丢弃请求
      }
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
