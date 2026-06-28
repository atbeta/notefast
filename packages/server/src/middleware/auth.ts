import type { Context, Next } from 'hono'

const AUTH_PASSWORD = process.env.AUTH_PASSWORD || ''
const API_TOKEN = process.env.API_TOKEN || ''

export function isAuthEnabled(): boolean {
  return !!(AUTH_PASSWORD || API_TOKEN)
}

export async function authMiddleware(c: Context, next: Next): Promise<void> {
  if (!isAuthEnabled()) {
    await next()
    return
  }

  const authHeader = c.req.header('Authorization') || ''

  if (API_TOKEN) {
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i)
    if (bearerMatch && bearerMatch[1] === API_TOKEN) {
      await next()
      return
    }
    const tokenParam = c.req.query('token') || ''
    if (tokenParam === API_TOKEN) {
      await next()
      return
    }
  }

  if (AUTH_PASSWORD) {
    const basicMatch = authHeader.match(/^Basic\s+(.+)$/i)
    if (basicMatch) {
      const decoded = atob(basicMatch[1])
      const [user, pass] = decoded.split(':')
      if (user === 'admin' && pass === AUTH_PASSWORD) {
        await next()
        return
      }
    }
  }

    c.json(
      { error: 'unauthorized', message: '需要有效的 API Token 或密码', hint: '使用 Authorization: Bearer <token> 或 Authorization: Basic YWRtaW46PHBhc3N3b3JkPg==' },
      401,
    )
    return
}
