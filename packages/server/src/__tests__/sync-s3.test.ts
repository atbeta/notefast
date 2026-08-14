/**
 * S3 Adapter 测试 — stub 兼容真实 AWS SDK Command
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
import { createS3Adapter, type S3ClientLike } from '../sync/s3'
import { ARCHIVE_MANIFEST_NAME } from '../sync/archive'
import { initStorageLocations, createStorageLocation, _resetStorageLocationsForTests } from '../storage/locations'

let testDir: string
let app: Hono
let locationId: string

interface RecordedPut {
  bucket: string
  key: string
  body: string
  contentType: string
}

function createStubClient(opts: { failKeys?: Set<string> } = {}): {
  client: S3ClientLike
  puts: RecordedPut[]
  deletes: string[]
  objects: Map<string, string>
} {
  const puts: RecordedPut[] = []
  const deletes: string[] = []
  const objects = new Map<string, string>()
  const client: S3ClientLike = {
    async send(command: unknown) {
      const cmd = command as { constructor: { name: string }; input: Record<string, unknown> }
      const name = cmd.constructor.name
      if (name === 'HeadBucketCommand') {
        if (opts.failKeys?.has('head')) throw new Error('HeadBucket failed (stub)')
        return { BucketRegion: 'us-east-1' }
      }
      if (name === 'GetObjectCommand') {
        const key = cmd.input.Key as string
        const body = objects.get(key)
        if (body === undefined) {
          const err = new Error('NoSuchKey')
          ;(err as { name: string }).name = 'NoSuchKey'
          throw err
        }
        return {
          Body: {
            transformToString: async () => body,
            transformToByteArray: async () => new TextEncoder().encode(body),
          },
        }
      }
      if (name === 'DeleteObjectCommand') {
        const key = cmd.input.Key as string
        deletes.push(key)
        objects.delete(key)
        return {}
      }
      if (name === 'PutObjectCommand') {
        const key = cmd.input.Key as string
        if (
          [...(opts.failKeys || [])].some((k) => k !== 'head' && (key === k || key.includes(k)))
        ) {
          throw new Error(`PutObject failed for ${key} (stub)`)
        }
        const body = String(cmd.input.Body ?? '')
        objects.set(key, body)
        puts.push({
          bucket: cmd.input.Bucket as string,
          key,
          body,
          contentType: (cmd.input.ContentType as string) || '',
        })
        return { ETag: 'stub-etag' }
      }
      throw new Error(`Unknown command ${name}`)
    },
  }
  return { client, puts, deletes, objects }
}

function seedDocWithBlocks(opts: { docTitle: string; blocks: Array<{ content: string }> }): string {
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
  for (const b of opts.blocks) {
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
  testDir = mkdtempSync(join('/tmp', 'notefast-s3-'))
  initDb(testDir)
  initStorageLocations(testDir)
  locationId = createStorageLocation({
    id: '',
    name: '测试 R2',
    kind: 's3',
    s3: { bucket: 'b', region: 'r', accessKeyId: 'k', secretAccessKey: 's' },
  }).id
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
  _resetStorageLocationsForTests()
  initStorageLocations(testDir)
  locationId = createStorageLocation({
    id: '',
    name: '测试 R2',
    kind: 's3',
    s3: { bucket: 'b', region: 'r', accessKeyId: 'k', secretAccessKey: 's' },
  }).id
  const cfg = join(testDir, 'sync.config.json')
  if (existsSync(cfg)) unlinkSync(cfg)
})

describe('S3 Adapter — 单元（stub client）', () => {
  test('push 上传每个文档为一个对象，文件名含 docId', async () => {
    const stub = createStubClient()
    const id1 = seedDocWithBlocks({ docTitle: 'doc-1', blocks: [{ content: 'p1' }] })
    seedDocWithBlocks({ docTitle: 'doc-2', blocks: [{ content: 'p2' }] })
    const adapter = createS3Adapter(
      { bucket: 'b', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' },
      '',
      true,
      { client: stub.client },
    )
    const r = await adapter.push()
    expect(r.pushed).toBe(2)
    const mdPuts = stub.puts.filter((p) => p.key.endsWith('.md'))
    expect(mdPuts.length).toBe(2)
    expect(mdPuts[0]!.key).toContain(id1.replace(/-/g, '').slice(0, 12))
    expect(mdPuts[0]!.key).toContain('doc-1--')
    expect(stub.puts.some((p) => p.key.endsWith(ARCHIVE_MANIFEST_NAME))).toBe(true)
  })

  test('同名标题不互相覆盖', async () => {
    const stub = createStubClient()
    const a = seedDocWithBlocks({ docTitle: 'Same', blocks: [] })
    const b = seedDocWithBlocks({ docTitle: 'Same', blocks: [] })
    const adapter = createS3Adapter(
      { bucket: 'b', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' },
      '',
      true,
      { client: stub.client },
    )
    await adapter.push()
    const keys = stub.puts.filter((p) => p.key.endsWith('.md')).map((p) => p.key)
    expect(new Set(keys).size).toBe(2)
    expect(keys.some((k) => k.includes(a.replace(/-/g, '').slice(0, 12)))).toBe(true)
    expect(keys.some((k) => k.includes(b.replace(/-/g, '').slice(0, 12)))).toBe(true)
  })

  test('删除文档后二次 push 清理陈旧对象', async () => {
    const stub = createStubClient()
    const keep = seedDocWithBlocks({ docTitle: 'Keep', blocks: [] })
    const gone = seedDocWithBlocks({ docTitle: 'Gone', blocks: [] })
    const adapter = createS3Adapter(
      { bucket: 'b', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' },
      '',
      true,
      { client: stub.client },
    )
    await adapter.push()
    getDb().query('DELETE FROM blocks WHERE id = ? OR root_id = ?').run(gone, gone)
    stub.puts.length = 0
    stub.deletes.length = 0
    await adapter.push()
    expect(stub.deletes.some((k) => k.includes(gone.replace(/-/g, '').slice(0, 12)))).toBe(true)
    expect(stub.puts.some((p) => p.key.includes(keep.replace(/-/g, '').slice(0, 12)))).toBe(true)
  })

  test('单文档 PutObject 失败不会中断其他文档', async () => {
    getDb().query('DELETE FROM blocks').run()
    seedDocWithBlocks({ docTitle: 'good-1', blocks: [] })
    seedDocWithBlocks({ docTitle: 'bad', blocks: [] })
    seedDocWithBlocks({ docTitle: 'good-2', blocks: [] })
    const stub = createStubClient({ failKeys: new Set(['bad--']) })
    const adapter = createS3Adapter(
      { bucket: 'b', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' },
      '',
      true,
      { client: stub.client },
    )
    const r = await adapter.push()
    expect(r.pushed).toBe(2)
    expect(r.errors.length).toBeGreaterThanOrEqual(1)
    expect(r.errors.some((e) => e.includes('PutObject failed'))).toBe(true)
  })

  test('prefix 归一化', async () => {
    const stub = createStubClient()
    seedDocWithBlocks({ docTitle: 'X', blocks: [] })
    const adapter = createS3Adapter(
      { bucket: 'b', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' },
      'notes',
      true,
      { client: stub.client },
    )
    await adapter.push()
    expect(stub.puts.every((p) => p.key.startsWith('notes/'))).toBe(true)
  })

  test('docIds 过滤生效', async () => {
    const stub = createStubClient()
    const a = seedDocWithBlocks({ docTitle: 'keep', blocks: [] })
    seedDocWithBlocks({ docTitle: 'skip', blocks: [] })
    const adapter = createS3Adapter(
      { bucket: 'b', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' },
      '',
      true,
      { client: stub.client },
    )
    const r = await adapter.push({ docIds: [a] })
    expect(r.pushed).toBe(1)
    expect(stub.puts.filter((p) => p.key.endsWith('.md')).length).toBe(1)
  })

  test('info() HeadBucket 成功/失败', async () => {
    const ok = createStubClient()
    const adapter = createS3Adapter(
      { bucket: 'my-bucket', region: 'eu-west-1', accessKeyId: 'k', secretAccessKey: 's', endpoint: 'https://minio.local', forcePathStyle: true },
      '',
      true,
      { client: ok.client },
    )
    const info = await adapter.info()
    expect((info.extra as { ok: boolean }).ok).toBe(true)

    const bad = createStubClient({ failKeys: new Set(['head']) })
    const adapter2 = createS3Adapter(
      { bucket: 'b', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' },
      '',
      true,
      { client: bad.client },
    )
    const info2 = await adapter2.info()
    expect((info2.extra as { ok: boolean }).ok).toBe(false)
  })
})

describe('Sync Manager × S3', () => {
  test('configure s3 后 configured=true', async () => {
    initSyncManager(testDir)
    await applySyncConfig({
      version: 1,
      active: {
        kind: 's3',
        locationId,
        enabled: true,
      },
    })
    expect(syncStatus().configured).toBe(true)
    expect(syncStatus().adapterName).toBe('s3')
  })
})

describe('Sync HTTP × S3', () => {
  async function api(method: string, path: string, body?: unknown) {
    const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
    if (body !== undefined) init.body = JSON.stringify(body)
    const res = await app.fetch(new Request(`http://localhost/api/v1/sync${path}`, init))
    return { status: res.status, body: await res.json() }
  }

  test('GET /adapters 中 s3 状态是 available', async () => {
    const { body } = await api('GET', '/adapters')
    const s3 = body.adapters.find((a: { kind: string }) => a.kind === 's3')
    expect(s3.status).toBe('available')
  })

  test('PUT 引用连接可保存', async () => {
    initSyncManager(testDir)
    const res = await api('PUT', '/config', {
      active: {
        kind: 's3',
        locationId,
        enabled: true,
      },
    })
    expect(res.status).toBe(200)
    const disk = JSON.parse(await Bun.file(join(testDir, 'sync.config.json')).text())
    expect(disk.active.kind).toBe('s3')
    expect(disk.active.locationId).toBe(locationId)
  })
})
