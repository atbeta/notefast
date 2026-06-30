import type { Context, Next, MiddlewareHandler } from 'hono'

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
 */

function safeTrim(s: string): string {
  return s.trim()
}

export function isAuthEnabled(): boolean {
  const apiToken = safeTrim(process.env.API_TOKEN || '')
  const authPassword = safeTrim(process.env.AUTH_PASSWORD || '')
  return apiToken.length > 0 || authPassword.length > 0
}

export const authMiddleware: MiddlewareHandler = async (c: Context, next: Next) => {
  const apiToken = safeTrim(process.env.API_TOKEN || '')
  const authPassword = safeTrim(process.env.AUTH_PASSWORD || '')

  if (apiToken.length === 0 && authPassword.length === 0) {
    await next()
    return
  }

  const authHeader = (c.req.header('Authorization') || '').trim()

  if (apiToken.length > 0) {
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i)
    if (bearerMatch) {
      const provided = bearerMatch[1]
      // 使用标准字符串比较，无短路径优化（长度泄漏可接受，暂不引入 crypto.timingSafeEqual）
      if (provided === apiToken) {
        await next()
        return
      }
    }
  }

  if (authPassword.length > 0) {
    const basicMatch = authHeader.match(/^Basic\s+(.+)$/i)
    if (basicMatch) {
      try {
        const decoded = atob(basicMatch[1])
        const colonIdx = decoded.indexOf(':')
        if (colonIdx > 0) {
          const user = decoded.slice(0, colonIdx)
          const pass = decoded.slice(colonIdx + 1)
          if (user === 'admin' && pass === authPassword) {
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
