import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { createToken, listTokens, revokeToken } from '../services/apiTokens'
import { requireScope } from '../middleware/auth'

const apiTokens = new Hono()

apiTokens.get('/', (c) => {
  if (!requireScope(c, 'admin')) return c.json({ error: 'forbidden', message: '需要 admin 权限' }, 403)
  const tokens = listTokens()
  return c.json(tokens.map((t) => ({
    token_id: t.token_id,
    name: t.name,
    scopes: JSON.parse(t.scopes) as string[],
    created_at: t.created_at,
    last_used_at: t.last_used_at,
  })))
})

const createSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(['read', 'write'])).optional().default(['read', 'write']),
})

apiTokens.post('/', zValidator('json', createSchema), (c) => {
  if (!requireScope(c, 'admin')) return c.json({ error: 'forbidden', message: '需要 admin 权限' }, 403)
  const { name, scopes } = c.req.valid('json')
  const result = createToken(name, scopes)
  return c.json({
    token_id: result.record.token_id,
    name: result.record.name,
    scopes: JSON.parse(result.record.scopes) as string[],
    created_at: result.record.created_at,
    token: result.plain,
  }, 201)
})

apiTokens.delete('/:tokenId', (c) => {
  if (!requireScope(c, 'admin')) return c.json({ error: 'forbidden', message: '需要 admin 权限' }, 403)
  const tokenId = c.req.param('tokenId')
  const ok = revokeToken(tokenId)
  if (!ok) return c.json({ error: 'not_found', message: 'Token 不存在或已撤销' }, 404)
  return c.json({ revoked: true })
})

export default apiTokens
