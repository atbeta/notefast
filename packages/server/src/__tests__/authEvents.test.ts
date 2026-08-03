/**
 * 登录审计测试
 *
 * 覆盖：
 * - POST /auth/session 成功后写入 auth_events 行
 * - GET /auth/events 需要鉴权（401 无凭证）
 * - GET /auth/events 返回已写入行
 * - X-Forwarded-For 首跳提取
 * - 缺少代理头 → ip = null
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb, getDb } from '../db'
import { authMiddleware, sessionTokenValue, SESSION_COOKIE } from '../middleware/auth'

let originalPassword: string | undefined
let originalToken: string | undefined
let testDir: string

beforeAll(() => {
  originalPassword = process.env.AUTH_PASSWORD
  originalToken = process.env.API_TOKEN
  testDir = mkdtempSync(join('/tmp', 'notefast-auth-events-'))
  process.env.AUTH_PASSWORD = 'test-pw'
  process.env.API_TOKEN = ''
  initDb(testDir)
})

afterAll(() => {
  process.env.AUTH_PASSWORD = originalPassword
  // initDb 生成了 api.key 并写入 API_TOKEN，必须还原（bun test 全部文件共享一个进程）
  process.env.API_TOKEN = originalToken
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  getDb().query('DELETE FROM auth_events').run()
})

function createApp() {
  const app = new Hono()
  app.use('/api/*', authMiddleware)

  app.post('/api/v1/auth/session', (c) => {
    const token = sessionTokenValue()
    if (!token) return c.json({ session: false })
    c.header('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`)
    try {
      const ip = c.req.header('cf-connecting-ip')
        || c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
        || c.req.header('x-real-ip')
        || null
      const ua = c.req.header('user-agent') ?? ''
      getDb().query(
        'INSERT INTO auth_events (id, event_type, ip, user_agent) VALUES (?, ?, ?, ?)',
      ).run(crypto.randomUUID(), 'login', ip, ua)
    } catch { /* 记录失败不影响登录流程 */ }
    return c.json({ session: true })
  })

  app.get('/api/v1/auth/events', (c) => {
    const rows = getDb().query(
      'SELECT id, event_type, ip, user_agent, created_at FROM auth_events ORDER BY created_at DESC LIMIT 30',
    ).all() as Array<{ id: string; event_type: string; ip: string | null; user_agent: string | null; created_at: string }>
    return c.json(rows)
  })

  return app
}

function basicAuth(pw: string) {
  return 'Basic ' + btoa('admin:' + pw)
}

describe('auth_events — 登录审计', () => {
  test('POST /auth/session 成功后写入一行审计记录', async () => {
    const app = createApp()
    const res = await app.fetch(new Request('http://localhost/api/v1/auth/session', {
      method: 'POST',
      headers: {
        Authorization: basicAuth('test-pw'),
        'User-Agent': 'test-agent/1.0',
      },
    }))
    expect(res.status).toBe(200)
    const count = (getDb().query('SELECT count(*) as c FROM auth_events').get() as { c: number }).c
    expect(count).toBe(1)
  })

  test('写入的审计行含 IP 与 UA', async () => {
    const app = createApp()
    await app.fetch(new Request('http://localhost/api/v1/auth/session', {
      method: 'POST',
      headers: {
        Authorization: basicAuth('test-pw'),
        'User-Agent': 'Firefox/120',
        'X-Real-IP': '10.0.0.1',
      },
    }))
    const row = getDb().query(
      'SELECT ip, user_agent FROM auth_events LIMIT 1',
    ).get() as { ip: string | null; user_agent: string | null }
    expect(row.ip).toBe('10.0.0.1')
    expect(row.user_agent).toBe('Firefox/120')
  })

  test('X-Forwarded-For 多跳时取第一个 IP', async () => {
    const app = createApp()
    await app.fetch(new Request('http://localhost/api/v1/auth/session', {
      method: 'POST',
      headers: {
        Authorization: basicAuth('test-pw'),
        'X-Forwarded-For': '203.0.113.1, 10.0.0.2',
      },
    }))
    const row = getDb().query(
      'SELECT ip FROM auth_events LIMIT 1',
    ).get() as { ip: string | null }
    expect(row.ip).toBe('203.0.113.1')
  })

  test('CF-Connecting-IP 优先于 X-Forwarded-For', async () => {
    const app = createApp()
    await app.fetch(new Request('http://localhost/api/v1/auth/session', {
      method: 'POST',
      headers: {
        Authorization: basicAuth('test-pw'),
        'CF-Connecting-IP': '1.2.3.4',
        'X-Forwarded-For': '10.0.0.1',
      },
    }))
    const row = getDb().query(
      'SELECT ip FROM auth_events LIMIT 1',
    ).get() as { ip: string | null }
    expect(row.ip).toBe('1.2.3.4')
  })

  test('缺少代理头时 ip 为 null', async () => {
    const app = createApp()
    await app.fetch(new Request('http://localhost/api/v1/auth/session', {
      method: 'POST',
      headers: { Authorization: basicAuth('test-pw') },
    }))
    const row = getDb().query(
      'SELECT ip FROM auth_events LIMIT 1',
    ).get() as { ip: string | null }
    expect(row.ip).toBeNull()
  })

  test('GET /auth/events 需要鉴权：无凭证 401', async () => {
    const app = createApp()
    const res = await app.fetch(new Request('http://localhost/api/v1/auth/events'))
    expect(res.status).toBe(401)
  })

  test('GET /auth/events 返回已写入的审计行', async () => {
    const app = createApp()
    // 写入两条
    await app.fetch(new Request('http://localhost/api/v1/auth/session', {
      method: 'POST',
      headers: {
        Authorization: basicAuth('test-pw'),
        'User-Agent': 'Chrome/125',
        'X-Forwarded-For': '192.168.1.1',
      },
    }))
    await app.fetch(new Request('http://localhost/api/v1/auth/session', {
      method: 'POST',
      headers: {
        Authorization: basicAuth('test-pw'),
        'User-Agent': 'Safari/17',
        'X-Real-IP': '10.0.0.99',
      },
    }))

    const res = await app.fetch(new Request('http://localhost/api/v1/auth/events', {
      headers: { Authorization: basicAuth('test-pw') },
    }))
    expect(res.status).toBe(200)
    const events = await res.json() as Array<Record<string, unknown>>
    expect(events.length).toBe(2)

    const uas = events.map((e) => e.user_agent).sort()
    expect(uas).toEqual(['Chrome/125', 'Safari/17'])
  })

  test('错误密码不写入审计记录', async () => {
    const app = createApp()
    const res = await app.fetch(new Request('http://localhost/api/v1/auth/session', {
      method: 'POST',
      headers: {
        Authorization: basicAuth('wrong-pw'),
        'User-Agent': 'BadAgent',
      },
    }))
    expect(res.status).toBe(401)
    const count = (getDb().query('SELECT count(*) as c FROM auth_events').get() as { c: number }).c
    expect(count).toBe(0)
  })

  test('空表返回空数组', async () => {
    const app = createApp()
    const res = await app.fetch(new Request('http://localhost/api/v1/auth/events', {
      headers: { Authorization: basicAuth('test-pw') },
    }))
    expect(res.status).toBe(200)
    const events = await res.json()
    expect(events).toEqual([])
  })
})
