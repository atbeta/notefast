import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { authMiddleware, isAuthEnabled } from '../middleware/auth'
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
})
