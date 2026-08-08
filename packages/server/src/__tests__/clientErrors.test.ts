/**
 * 客户端错误埋点 API 测试
 *
 * 覆盖：
 *  - 未鉴权请求 → 401（authMiddleware 全局生效）
 *  - 单条 error 正常入库
 *  - 批量多条全部 accepted
 *  - zod 校验失败 → 400
 *  - 7 天前的旧行被 initClientErrors() 清掉
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../app'
import { initClientErrors } from '../api/clientErrors'
import { getDb } from '../db'

let testDir: string
let app: ReturnType<typeof createApp>
const TOKEN = 'test-token-123'
const savedApiToken = process.env.API_TOKEN

beforeAll(async () => {
  process.env.API_TOKEN = TOKEN
  testDir = mkdtempSync(join(tmpdir(), 'nf-client-errors-'))
  app = createApp({ dataDir: testDir })
  await app.start()
  initClientErrors()
})

afterAll(async () => {
  await app.stop()
  if (savedApiToken === undefined) delete process.env.API_TOKEN
  else process.env.API_TOKEN = savedApiToken
  rmSync(testDir, { recursive: true, force: true })
})

const authedRequest = (path: string, init: RequestInit = {}) =>
  app.app.request(path, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${TOKEN}` },
  })

const sampleError = (overrides: Record<string, unknown> = {}) => ({
  source: 'boundary' as const,
  message: 'Cannot read properties of undefined (reading "foo")',
  stack: 'Error: ...\n    at SomeComponent (app.tsx:42)',
  componentStack: '\n    at SomeComponent (app.tsx:42)',
  hash: 'a'.repeat(64),
  url: '/doc/abc',
  appVersion: '0.51.0',
  ...overrides,
})

describe('client-errors API', () => {
  test('未鉴权 → 401', async () => {
    const res = await app.app.request('/api/v1/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ errors: [sampleError()] }),
    })
    expect(res.status).toBe(401)
  })

  test('单条错误入库', async () => {
    const before = (getDb().query('SELECT COUNT(*) AS c FROM client_errors').get() as { c: number }).c
    const res = await authedRequest('/api/v1/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ errors: [sampleError()] }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accepted: 1 })

    const after = (getDb().query('SELECT COUNT(*) AS c FROM client_errors').get() as { c: number }).c
    expect(after - before).toBe(1)
  })

  test('批量多条全部 accepted', async () => {
    const before = (getDb().query('SELECT COUNT(*) AS c FROM client_errors').get() as { c: number }).c
    const errors = [sampleError({ hash: 'b'.repeat(64) }), sampleError({ hash: 'c'.repeat(64) })]
    const res = await authedRequest('/api/v1/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ errors }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as { accepted: number }).toEqual({ accepted: 2 })

    const after = (getDb().query('SELECT COUNT(*) AS c FROM client_errors').get() as { c: number }).c
    expect(after - before).toBe(2)
  })

  test('zod 校验失败 → 400', async () => {
    const res = await authedRequest('/api/v1/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ errors: [{ source: 'unknown', message: '', hash: '' }] }),
    })
    expect(res.status).toBe(400)
  })

  test('source / message / hash 字段缺失 → 400', async () => {
    const res = await authedRequest('/api/v1/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ errors: [{ source: 'boundary', message: 'x' }] }),
    })
    expect(res.status).toBe(400)
  })

  test('超过 50 条 / batch → 400', async () => {
    const errors = Array.from({ length: 51 }, () => sampleError())
    const res = await authedRequest('/api/v1/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ errors }),
    })
    expect(res.status).toBe(400)
  })
})

describe('initClientErrors TTL', () => {
  test('7 天前的行被清掉', () => {
    const db = getDb()
    // 注入一条 8 天前的旧行
    db.query(
      `INSERT INTO client_errors (source, message, hash, received_at) VALUES (?, ?, ?, datetime('now', '-8 days'))`,
    ).run('window', 'old error', 'd'.repeat(64))
    const before = (db.query('SELECT COUNT(*) AS c FROM client_errors').get() as { c: number }).c

    initClientErrors()

    const after = (db.query('SELECT COUNT(*) AS c FROM client_errors').get() as { c: number }).c
    expect(after).toBe(before - 1)
  })
})