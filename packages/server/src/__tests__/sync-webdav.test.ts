/**
 * WebDAV Adapter 测试
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
import { ARCHIVE_MANIFEST_NAME } from '../sync/archive'

let testDir: string
let app: Hono

function createStubClient(opts: { failUrls?: RegExp[]; failMethods?: string[] } = {}): {
  client: WebDavClientLike
  requests: Array<{ method: string; url: string; body?: string }>
  files: Map<string, string>
  set propfindResponse(s: string)
} {
  const requests: Array<{ method: string; url: string; body?: string }> = []
  const files = new Map<string, string>()
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
      if (method === 'GET') {
        const path = new URL(url).pathname
        // find by matching stored keys in url
        for (const [k, v] of files) {
          if (url.includes(k) || path.endsWith('/' + k) || path.endsWith(k)) {
            return { status: 200, body: v }
          }
        }
        return { status: 404, body: '' }
      }
      if (method === 'PUT') {
        const path = decodeURIComponent(new URL(url).pathname)
        const name = path.split('/').pop() || path
        files.set(name, body || '')
        // also store by relative key suffix for GET
        if (body) files.set(path.replace(/^\/+/, ''), body)
        return { status: 201, body: '' }
      }
      if (method === 'DELETE') return { status: 204, body: '' }
      return { status: 200, body: '' }
    },
  }
  return {
    client,
    requests,
    files,
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
  test('push 上传每个文档为一个 .md，文件名含 docId', async () => {
    const stub = createStubClient()
    const id = seedDocWithBlocks({ docTitle: 'Hello', blocks: [{ content: 'paragraph' }] })
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
    const puts = stub.requests.filter((r) => r.method === 'PUT' && r.url.endsWith('.md'))
    expect(puts.length).toBe(2)
    expect(puts[0]!.url).toContain('/dav/notes/Hello--')
    expect(puts[0]!.url).toContain(id.replace(/-/g, '').slice(0, 12))
    expect(stub.requests.some((r) => r.url.includes(ARCHIVE_MANIFEST_NAME))).toBe(true)
  })

  test('prefix 与 endpoint 末尾 slash 兼容', async () => {
    seedDocWithBlocks({ docTitle: 'X', blocks: [] })
    const cases: Array<{ endpoint: string; prefix?: string; expectMkcol: string[] }> = [
      { endpoint: 'https://a.example/dav', prefix: 'n', expectMkcol: ['/dav/n/'] },
      { endpoint: 'https://a.example/dav/', prefix: '/n/', expectMkcol: ['/dav/n/'] },
      {
        endpoint: 'https://a.example/remote.php/webdav',
        prefix: 'sub/dir',
        expectMkcol: ['/remote.php/webdav/sub/', '/remote.php/webdav/sub/dir/'],
      },
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
      const mkcols = stub.requests
        .filter((r) => r.method === 'MKCOL')
        .map((r) => r.url.replace(/^https?:\/\/[^/]+/, ''))
      expect([...mkcols].sort(), `for endpoint=${c.endpoint}`).toEqual([...c.expectMkcol].sort())
    }
  })

  test('单文档 PUT 失败不会中断其他文档', async () => {
    seedDocWithBlocks({ docTitle: 'Bad', blocks: [] })
    seedDocWithBlocks({ docTitle: 'Good1', blocks: [] })
    seedDocWithBlocks({ docTitle: 'Good2', blocks: [] })
    const stubClient: WebDavClientLike = {
      async send({ method, url }) {
        if (method === 'GET') return { status: 404, body: '' }
        if (method === 'PUT' && url.includes('Bad--')) return { status: 500, body: 'denied' }
        if (method === 'PUT') return { status: 201, body: '' }
        if (method === 'MKCOL') return { status: 201, body: '' }
        if (method === 'DELETE') return { status: 204, body: '' }
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
    expect(r.errors.length).toBeGreaterThanOrEqual(1)
  })

  test('info() 返回 reachable 与 fileCount', async () => {
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
    expect((info.extra as { fileCount: number }).fileCount).toBe(2)
  })

  test('Basic Auth header 正确', async () => {
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
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['Authorization']).toBe(`Basic ${Buffer.from('alice:s3cret').toString('base64')}`)
  })
})

describe('WebDAV × Manager / HTTP', () => {
  async function api(method: string, path: string, body?: unknown) {
    const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
    if (body !== undefined) init.body = JSON.stringify(body)
    const res = await app.fetch(new Request(`http://localhost/api/v1/sync${path}`, init))
    return { status: res.status, body: await res.json() }
  }

  test('configure webdav', async () => {
    await applySyncConfig({
      version: 1,
      active: {
        kind: 'webdav',
        endpoint: 'https://x/dav',
        username: 'u',
        password: 'p',
        enabled: true,
      },
    })
    expect(syncStatus().adapterName).toBe('webdav')
  })

  test('GET /adapters webdav available', async () => {
    const { body } = await api('GET', '/adapters')
    const webdav = body.adapters.find((a: { kind: string }) => a.kind === 'webdav')
    expect(webdav.status).toBe('available')
  })
})
