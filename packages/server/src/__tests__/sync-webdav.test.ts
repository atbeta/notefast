/**
 * WebDAV Adapter 测试
 *
 * 通过 WebDavClientLike stub 验证 push / info / 错误路径
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { initDb, closeDb, getDb } from '../db'
import syncRouter from '../api/sync'
import {
  initSyncManager,
  syncStatus,
  applySyncConfig,
  _resetForTests,
} from '../sync/manager'
import { createWebDavAdapter, createDefaultClient, type WebDavClientLike } from '../sync/webdav'

let testDir: string
let app: Hono

function createStubClient(opts: { failUrls?: RegExp[]; failMethods?: string[] } = {}): {
  client: WebDavClientLike
  requests: Array<{ method: string; url: string; body?: string }>
  propfindResponse?: string
} {
  const requests: Array<{ method: string; url: string; body?: string }> = []
  let propfindBody = ''
  const client: WebDavClientLike = {
    async send({ method, url, body }) {
      requests.push({ method, url, body })
      const shouldFail =
        opts.failUrls?.some((re) => re.test(url)) ||
        opts.failMethods?.includes(method.toUpperCase())
      if (shouldFail) {
        return { status: 500, body: 'simulated failure' }
      }
      if (method === 'PROPFIND') return { status: 207, body: propfindBody }
      if (method === 'MKCOL') return { status: 201, body: '' }
      if (method === 'PUT') return { status: 201, body: '' }
      return { status: 200, body: '' }
    },
  }
  return {
    client,
    requests,
    set propfindResponse(s: string) {
      propfindBody = s
    },
  }
}

function seedDocWithBlocks(opts: {
  docTitle: string
  blocks?: Array<{ content: string }>
}): string {
  const db = getDb()
  const nb = crypto.randomUUID()
  db.query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
  const docId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'document', ?, 0, 0, ?, ?)`,
  ).run(docId, nb, docId, opts.docTitle, now, now)
  let level = 1
  for (const b of opts.blocks ?? []) {
    const bid = crypto.randomUUID()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'paragraph', ?, 0, ?, ?, ?)`,
    ).run(bid, nb, docId, docId, b.content, level, now, now)
    level++
  }
  return docId
}

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-webdav-'))
  initDb(testDir)
  app = new Hono()
  app.use('*', cors({ origin: '*' }))
  app.route('/api/v1/sync', syncRouter)
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  getDb().query('DELETE FROM blocks').run()
  getDb().exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")
  _resetForTests()
  const cfg = join(testDir, 'sync.config.json')
  if (existsSync(cfg)) unlinkSync(cfg)
  initSyncManager(testDir)
})

describe('WebDAV Adapter — 单元（stub client）', () => {
  test('push 上传每个文档为一个 .md，prefix 归一', async () => {
    const stub = createStubClient()
    seedDocWithBlocks({ docTitle: 'Hello', blocks: [{ content: 'paragraph' }] })
    seedDocWithBlocks({ docTitle: 'Second', blocks: [] })

    const adapter = createWebDavAdapter(
      {
        kind: 'webdav',
        endpoint: 'https://nas.local/dav/',
        username: 'u',
        password: 'p',
        prefix: 'notes',
        enabled: true,
      },
      { client: stub.client },
    )
    const r = await adapter.push()
    expect(r.pushed).toBe(2)
    // 应有 2 个 MKCOL（notes/） + 2 个 PUT
    const puts = stub.requests.filter((r) => r.method === 'PUT')
    expect(puts.length).toBe(2)
    expect(puts[0]!.url).toContain('/dav/notes/Hello.md')
    expect(puts[0]!.url.startsWith('https://nas.local/')).toBe(true)
    // body 应包含文档内容
    expect(puts[0]!.body).toContain('Hello')
  })

  test('prefix 与 endpoint 末尾 slash 兼容多种写法', async () => {
    seedDocWithBlocks({ docTitle: 'X', blocks: [] })
    const cases: Array<{ endpoint: string; prefix?: string; expectMkcol: string[] }> = [
      { endpoint: 'https://a.example/dav', prefix: 'n', expectMkcol: ['/dav/n/'] },
      { endpoint: 'https://a.example/dav/', prefix: '/n/', expectMkcol: ['/dav/n/'] },
      { endpoint: 'https://a.example/remote.php/webdav', prefix: 'sub/dir', expectMkcol: ['/remote.php/webdav/sub/', '/remote.php/webdav/sub/dir/'] },
      { endpoint: 'https://a.example/remote.php/webdav/', expectMkcol: [] },
    ]
    for (const c of cases) {
      const stub = createStubClient()
      const adapter = createWebDavAdapter(
        {
          kind: 'webdav',
          endpoint: c.endpoint,
          username: 'u',
          password: 'p',
          prefix: c.prefix,
          enabled: true,
        },
        { client: stub.client },
      )
      await adapter.push()
      const mkcols = stub.requests.filter((r) => r.method === 'MKCOL').map((r) => r.url.replace(/^https?:\/\/[^/]+/, ''))
      const sortedExpected = [...c.expectMkcol].sort()
      expect([...mkcols].sort(), `for endpoint=${c.endpoint} prefix=${c.prefix}`).toEqual(sortedExpected)
    }
  })

  test('docIds 过滤生效', async () => {
    const stub = createStubClient()
    const a = seedDocWithBlocks({ docTitle: 'Keep', blocks: [] })
    seedDocWithBlocks({ docTitle: 'Skip', blocks: [] })
    const adapter = createWebDavAdapter(
      {
        kind: 'webdav',
        endpoint: 'https://x/dav',
        username: 'u',
        password: 'p',
        enabled: true,
      },
      { client: stub.client },
    )
    const r = await adapter.push({ docIds: [a] })
    expect(r.pushed).toBe(1)
    const puts = stub.requests.filter((r) => r.method === 'PUT')
    expect(puts.length).toBe(1)
    expect(puts[0]!.url).toContain('Keep.md')
  })

  test('单文档 PUT 失败不会中断其他文档', async () => {
    seedDocWithBlocks({ docTitle: 'Bad', blocks: [] })
    seedDocWithBlocks({ docTitle: 'Good1', blocks: [] })
    seedDocWithBlocks({ docTitle: 'Good2', blocks: [] })
    // 让 PUT on Bad.md 失败：URL test
    const stubClient: WebDavClientLike = {
      async send({ method, url }) {
        if (method === 'PUT' && url.includes('Bad.md')) return { status: 500, body: 'denied' }
        if (method === 'PUT') return { status: 201, body: '' }
        if (method === 'MKCOL') return { status: 201, body: '' }
        return { status: 200, body: '' }
      },
    }
    const adapter = createWebDavAdapter(
      {
        kind: 'webdav',
        endpoint: 'https://x/dav',
        username: 'u',
        password: 'p',
        enabled: true,
      },
      { client: stubClient },
    )
    const r = await adapter.push()
    expect(r.pushed).toBe(2)
    expect(r.errors.length).toBe(1)
    expect(r.errors[0]).toContain('PUT 500')
  })

  test('info() 返回 reachable=true 与 fileCount', async () => {
    const stub = createStubClient()
    stub.propfindResponse = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/dav/a.md</d:href></d:response>
  <d:response><d:href>/dav/b.md</d:href></d:response>
  <d:response><d:href>/dav/c.txt</d:href></d:response>
</d:multistatus>`
    const adapter = createWebDavAdapter(
      {
        kind: 'webdav',
        endpoint: 'https://x/dav/',
        username: 'u',
        password: 'p',
        enabled: true,
      },
      { client: stub.client },
    )
    const info = await adapter.info()
    expect((info.extra as { reachable: boolean }).reachable).toBe(true)
    expect((info.extra as { status: number }).status).toBe(207)
    expect((info.extra as { fileCount: number }).fileCount).toBe(2)
  })

  test('info() 在 PROPFIND 失败时返回 reachable=false', async () => {
    const stub = createStubClient({ failMethods: ['PROPFIND'] })
    const adapter = createWebDavAdapter(
      {
        kind: 'webdav',
        endpoint: 'https://x/dav',
        username: 'u',
        password: 'p',
        enabled: true,
      },
      { client: stub.client },
    )
    const info = await adapter.info()
    expect((info.extra as { reachable: boolean }).reachable).toBe(false)
  })

  test('createWebDavAdapter 缺 endpoint → 抛错', () => {
    expect(() => createWebDavAdapter(
      { kind: 'webdav', endpoint: '', username: 'u', password: 'p', enabled: true },
      { client: createStubClient().client },
    )).toThrow(/endpoint/)
  })

  test('createWebDavAdapter 缺 username / password → 抛错', () => {
    expect(() => createWebDavAdapter(
      { kind: 'webdav', endpoint: 'https://x/dav', username: '', password: 'p', enabled: true },
      { client: createStubClient().client },
    )).toThrow(/username/)
    expect(() => createWebDavAdapter(
      { kind: 'webdav', endpoint: 'https://x/dav', username: 'u', password: '', enabled: true },
      { client: createStubClient().client },
    )).toThrow(/password/)
  })

  test('Basic Auth header 在默认 client 里正确', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fakeFetch: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response('', { status: 207, headers: { 'content-type': 'text/xml' } })
    }) as unknown as typeof fetch
    const client = createDefaultClient(
      {
        kind: 'webdav',
        endpoint: 'https://x/dav',
        username: 'alice',
        password: 's3cret',
        enabled: true,
      },
      fakeFetch,
    )
    await client.send({ method: 'PROPFIND', url: 'https://x/dav/' })
    expect(calls.length).toBe(1)
    const first = calls[0]!
    const headers = first.init.headers as Record<string, string>
    expect(headers['Authorization']).toBe(`Basic ${Buffer.from('alice:s3cret').toString('base64')}`)
    expect(first.init.method).toBe('PROPFIND')
  })
})

describe('WebDAV × Manager 集成', () => {
  test('configure webdav 后 configured=true + adapterName=webdav', async () => {
    initSyncManager(testDir)
    await applySyncConfig({
      version: 1,
      active: {
        kind: 'webdav',
        endpoint: 'https://x/dav',
        username: 'u',
        password: 'p',
        enabled: true,
      },
    } as never)
    expect(syncStatus().configured).toBe(true)
    expect(syncStatus().adapterName).toBe('webdav')
  })
})

describe('WebDAV × HTTP', () => {
  async function api(method: string, path: string, body?: unknown) {
    const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
    if (body !== undefined) init.body = JSON.stringify(body)
    const res = await app.fetch(new Request(`http://localhost/api/v1/sync${path}`, init))
    return { status: res.status, body: await res.json() }
  }

  test('GET /adapters 中 webdav status=available', async () => {
    const { body } = await api('GET', '/adapters')
    const webdav = body.adapters.find((a: { kind: string }) => a.kind === 'webdav')
    expect(webdav.status).toBe('available')
    const fields = webdav.fields.map((f: { name: string }) => f.name)
    expect(fields).toContain('endpoint')
    expect(fields).toContain('username')
    expect(fields).toContain('password')
  })

  test('PUT /config webdav 配置可保存', async () => {
    initSyncManager(testDir)
    const { status, body } = await api('PUT', '/config', {
      active: {
        kind: 'webdav',
        endpoint: 'https://nas.local/dav/',
        username: 'alice',
        password: 's3cret',
        prefix: 'notes',
        enabled: true,
      },
    })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.status.configured).toBe(true)
    expect(body.status.adapterName).toBe('webdav')
  })
})
