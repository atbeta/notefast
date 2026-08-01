import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { authMiddleware, isAuthEnabled } from '../middleware/auth'
import { createToken, createWebSessionToken, revokeWebSessionTokens, listTokens } from '../services/apiTokens'
import { getDb } from '../db'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb } from '../db'

let originalToken: string | undefined
let originalPassword: string | undefined
let testDir: string

beforeAll(() => {
  originalToken = process.env.API_TOKEN
  originalPassword = process.env.AUTH_PASSWORD
  testDir = mkdtempSync(join('/tmp', 'notefast-auth-test-'))
  initDb(testDir)
})

afterAll(() => {
  process.env.API_TOKEN = originalToken
  process.env.AUTH_PASSWORD = originalPassword
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

function createApp() {
  const app = new Hono()
  app.use('/api/*', authMiddleware)
  app.get('/api/v1/test', (c) => c.json({ ok: true }))
  return app
}

describe('authMiddleware', () => {
  test('无鉴权配置时允许通过', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = ''
    expect(isAuthEnabled()).toBe(false)

    const app = createApp()
    const res = await app.fetch(new Request('http://localhost/api/v1/test'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })
  })

  test('Bearer Token 鉴权通过', async () => {
    process.env.API_TOKEN = 'test-token-123'
    process.env.AUTH_PASSWORD = ''

    const app = createApp()
    const res = await app.fetch(
      new Request('http://localhost/api/v1/test', {
        headers: { Authorization: 'Bearer test-token-123' },
      }),
    )
    expect(res.status).toBe(200)
  })

  test('错误的 Bearer Token 返回 401', async () => {
    process.env.API_TOKEN = 'test-token-123'
    process.env.AUTH_PASSWORD = ''

    const app = createApp()
    const res = await app.fetch(
      new Request('http://localhost/api/v1/test', {
        headers: { Authorization: 'Bearer wrong-token' },
      }),
    )
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('unauthorized')
  })

  test('Basic Auth 鉴权通过', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = 'mypassword'

    const app = createApp()
    const res = await app.fetch(
      new Request('http://localhost/api/v1/test', {
        headers: { Authorization: 'Basic ' + btoa('admin:mypassword') },
      }),
    )
    expect(res.status).toBe(200)
  })

  test('错误的密码返回 401', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = 'mypassword'

    const app = createApp()
    const res = await app.fetch(
      new Request('http://localhost/api/v1/test', {
        headers: { Authorization: 'Basic ' + btoa('admin:wrongpass') },
      }),
    )
    expect(res.status).toBe(401)
  })

  test('无 Authorization header 返回 401', async () => {
    process.env.API_TOKEN = 'required-token'

    const app = createApp()
    const res = await app.fetch(new Request('http://localhost/api/v1/test'))
    expect(res.status).toBe(401)
  })

  test('URL query ?token= 不再接受（避免日志泄露）', async () => {
    process.env.API_TOKEN = 'test-token-123'
    process.env.AUTH_PASSWORD = ''

    const app = createApp()
    const res = await app.fetch(new Request('http://localhost/api/v1/test?token=test-token-123'))
    expect(res.status).toBe(401)
  })

  test('非法 Base64 编码不导致 500', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = 'mypassword'

    const app = createApp()
    const res = await app.fetch(
      new Request('http://localhost/api/v1/test', {
        headers: { Authorization: 'Basic !!!not-valid-base64!!!' },
      }),
    )
    expect(res.status).toBe(401)
  })

  test('api_tokens 的 scopes 为非法 JSON 时返回 401 而非 500', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = 'mypassword'

    const { plain, record } = createToken('broken-scopes', ['read'])
    // 模拟历史写入 / 直接 SQL 操作产生的脏数据
    getDb().query('UPDATE api_tokens SET scopes = ? WHERE token_id = ?').run('not-json{', record.token_id)

    const app = createApp()
    const res = await app.fetch(
      new Request('http://localhost/api/v1/test', {
        headers: { Authorization: `Bearer ${plain}` },
      }),
    )
    expect(res.status).toBe(401)
  })

  test('环境变量前后空格被 trim 掉', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = '  mypassword  '

    const app = createApp()
    const res = await app.fetch(
      new Request('http://localhost/api/v1/test', {
        headers: { Authorization: 'Basic ' + btoa('admin:mypassword') },
      }),
    )
    expect(res.status).toBe(200)
  })

  test('会话 token 鉴权通过', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = 'test-pw'

    const { plain } = createWebSessionToken(true) // remember=7d
    const app = createApp()
    const res = await app.fetch(
      new Request('http://localhost/api/v1/test', {
        headers: { Authorization: `Bearer ${plain}` },
      }),
    )
    expect(res.status).toBe(200)
  })

  test('过期的会话 token 返回 401', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = 'test-pw'

    const { tokenId, plain } = createWebSessionToken(true)
    // 手动将 expires_at 设为过去时间
    getDb().query("UPDATE api_tokens SET expires_at = datetime('now', '-1 day') WHERE token_id = ?")
      .run(tokenId)

    const app = createApp()
    const res = await app.fetch(
      new Request('http://localhost/api/v1/test', {
        headers: { Authorization: `Bearer ${plain}` },
      }),
    )
    expect(res.status).toBe(401)
  })

  test('revokeWebSessionTokens 撤销后 token 立即失效', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = 'test-pw'

    const { plain } = createWebSessionToken(true)
    revokeWebSessionTokens()

    const app = createApp()
    const res = await app.fetch(
      new Request('http://localhost/api/v1/test', {
        headers: { Authorization: `Bearer ${plain}` },
      }),
    )
    expect(res.status).toBe(401)
  })

  test('listTokens 不包含 web-session token', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = 'test-pw'

    // 清理残留的 web-session token（前序测试可能留下）
    getDb().query("DELETE FROM api_tokens WHERE name = 'web-session'").run()

    createWebSessionToken(true)
    createToken('my-app', ['read'])

    const tokens = listTokens()
    // 排除 web-session 后只应看到用户创建的 token
    const names = tokens.map((t) => t.name)
    expect(names).toContain('my-app')
    expect(names).not.toContain('web-session')
  })

  test('web-session token 的 scopes 为 admin', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = 'test-pw'

    getDb().query("DELETE FROM api_tokens WHERE name = 'web-session'").run()

    const { plain } = createWebSessionToken(true)
    // 验证 admin scope：token 能通过 admin 级鉴权
    const app = createApp()
    const res = await app.fetch(
      new Request('http://localhost/api/v1/test', {
        headers: { Authorization: `Bearer ${plain}` },
      }),
    )
    expect(res.status).toBe(200)
  })
})
