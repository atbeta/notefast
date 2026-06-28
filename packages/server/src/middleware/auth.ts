import type { Context, Next, MiddlewareHandler } from 'hono'

export function isAuthEnabled(): boolean {
  return !!(process.env.AUTH_PASSWORD || process.env.API_TOKEN)
}

export const authMiddleware: MiddlewareHandler = async (c: Context, next: Next) => {
  const apiToken = process.env.API_TOKEN || ''
  const authPassword = process.env.AUTH_PASSWORD || ''

  if (!apiToken && !authPassword) {
    await next()
    return
  }

  const authHeader = c.req.header('Authorization') || ''

  if (apiToken) {
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i)
    if (bearerMatch && bearerMatch[1] === apiToken) {
      await next()
      return
    }
    const tokenParam = c.req.query('token') || ''
    if (tokenParam === apiToken) {
      await next()
      return
    }
  }

  if (authPassword) {
    const basicMatch = authHeader.match(/^Basic\s+(.+)$/i)
    if (basicMatch) {
      const decoded = atob(basicMatch[1])
      const [user, pass] = decoded.split(':')
      if (user === 'admin' && pass === authPassword) {
        await next()
        return
      }
    }
  }

  return c.json(
    { error: 'unauthorized', message: '需要有效的 API Token 或密码', hint: '使用 Authorization: Bearer <token> 或 Authorization: Basic YWRtaW46PHBhc3N3b3JkPg==' },
    401,
  )
}
