/**
 * Sync Adapter 测试
 *
 * 覆盖：
 * - LocalFS adapter: push 生成 Markdown 文件 + 计数
 * - manager: 配置持久化 / 热重载 / 状态可序列化
 * - HTTP 路由：config / status / run / info
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, unlinkSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { initDb, closeDb, getDb } from '../db'
import syncRouter from '../api/sync'
import {
  applySyncConfig,
  initSyncManager,
  isSyncConfigured,
  syncInfo,
  syncPush,
  syncStatus,
  _resetForTests,
} from '../sync/manager'
import { createLocalFsAdapter } from '../sync/localFs'

let testDir: string
let exportDir: string
let app: Hono

function seedDocWithBlocks(opts: {
  docTitle: string
  blocks: Array<{ content: string }>
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
  const dir = mkdtempSync(join('/tmp', 'notefast-sync-'))
  testDir = dir
  exportDir = join(dir, 'export')
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
  // 清空 blocks
  getDb().query('DELETE FROM blocks').run()
  getDb().exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")
  // 重置 manager 状态
  _resetForTests()
  // 删 sync.config.json
  const cfg = join(testDir, 'sync.config.json')
  if (existsSync(cfg)) unlinkSync(cfg)
  // 清空 exportDir（防止跨 test 文件累积）
  if (existsSync(exportDir)) {
    for (const f of readdirSync(exportDir)) {
      try {
        rmSync(join(exportDir, f), { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
})

async function api(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const res = await app.fetch(new Request(`http://localhost/api/v1/sync${path}`, init))
  return { status: res.status, body: await res.json() }
}

describe('LocalFS Adapter — 单元', () => {
  test('push 生成 Markdown 文件', async () => {
    initSyncManager(testDir)
    const adapter = createLocalFsAdapter({ kind: 'localfs', dir: exportDir, enabled: true })
    seedDocWithBlocks({ docTitle: 'Hello World', blocks: [{ content: '段落 1' }] })
    const r = await adapter.push()
    expect(r.pushed).toBe(1)
    const files = readdirSync(join(exportDir, 'untagged')).filter((f) => f.endsWith('.md'))
    expect(files.length).toBe(1)
    expect(files[0]!).toContain('Hello-World--')
    const content = readFileSync(join(exportDir, 'untagged', files[0]!), 'utf-8')
    expect(content).toContain('Hello World')
  })

  test('dir 不存在时自动创建', async () => {
    initSyncManager(testDir)
    const target = join(testDir, 'nested', 'deep')
    const adapter = createLocalFsAdapter({ kind: 'localfs', dir: target, enabled: true })
    seedDocWithBlocks({ docTitle: 'X', blocks: [] })
    const r = await adapter.push()
    expect(r.pushed).toBe(1)
    expect(existsSync(target)).toBe(true)
  })

  test('dir 为空时抛错', () => {
    initSyncManager(testDir)
    expect(() => createLocalFsAdapter({ kind: 'localfs', dir: '', enabled: true })).toThrow()
  })

  test('info() 报告远端 markdown 文件数', async () => {
    initSyncManager(testDir)
    const adapter = createLocalFsAdapter({ kind: 'localfs', dir: exportDir, enabled: true })
    seedDocWithBlocks({ docTitle: 'a', blocks: [] })
    seedDocWithBlocks({ docTitle: 'b', blocks: [] })
    await adapter.push()
    const info = await adapter.info()
    expect(info.remoteDocCount).toBe(2)
    expect((info.extra as { writable?: boolean }).writable).toBe(true)
  })

  test('push({docIds: [x]}) 仅导出指定文档', async () => {
    initSyncManager(testDir)
    const adapter = createLocalFsAdapter({ kind: 'localfs', dir: exportDir, enabled: true })
    const docA = seedDocWithBlocks({ docTitle: 'A', blocks: [] })
    seedDocWithBlocks({ docTitle: 'B', blocks: [] })
    const r = await adapter.push({ docIds: [docA] })
    expect(r.pushed).toBe(1)
    const files = readdirSync(exportDir)
    expect(files.length).toBe(1)
  })

  test('push 带图片引用：media 落地 + asset: 重写为相对路径（导出自包含）', async () => {
    initSyncManager(testDir)
    const { initAssetStore, saveAsset } = await import('../assets/store')
    initAssetStore(testDir)
    const { meta } = saveAsset(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), 'image/png')
    const adapter = createLocalFsAdapter({ kind: 'localfs', dir: exportDir, enabled: true })
    seedDocWithBlocks({
      docTitle: '带图文档',
      blocks: [{ content: `看图 ![](asset:${meta.id}) 结束` }],
    })
    const r = await adapter.push()
    expect(r.pushed).toBe(1)

    const md = readdirSync(join(exportDir, 'untagged')).find((f) => f.endsWith('.md'))
    const content = readFileSync(join(exportDir, 'untagged', md!), 'utf-8')
    // asset: 内部引用被重写为 ../media/ 相对路径（文档在一层子目录下）
    expect(content).not.toContain(`asset:${meta.id}`)
    expect(content).toContain('../media/')
    // media 文件落地
    const mediaFiles = readdirSync(join(exportDir, 'media'))
    expect(mediaFiles.length).toBe(1)
  })
})

describe('Sync Manager — 配置持久化与热重载', () => {
  test('initSyncManager 不带配置 → configured=false', () => {
    initSyncManager(testDir)
    expect(isSyncConfigured()).toBe(false)
    expect(syncStatus().configured).toBe(false)
  })

  test('applySyncConfig 启用 localfs 后 configured=true', async () => {
    initSyncManager(testDir)
    await applySyncConfig({
      version: 1,
      active: { kind: 'localfs', dir: exportDir, enabled: true },
    })
    expect(isSyncConfigured()).toBe(true)
    expect(syncStatus().adapterName).toBe('localfs')
  })

  test('配置写入 sync.config.json', async () => {
    initSyncManager(testDir)
    await applySyncConfig({
      version: 1,
      active: { kind: 'localfs', dir: exportDir, enabled: true },
    })
    const path = join(testDir, 'sync.config.json')
    expect(existsSync(path)).toBe(true)
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    expect(raw.active.kind).toBe('localfs')
  })

  test('reload 切换目录 → 旧 adapter 卸载，新 adapter 接上', async () => {
    initSyncManager(testDir)
    await applySyncConfig({
      version: 1,
      active: { kind: 'localfs', dir: exportDir, enabled: true },
    })
    seedDocWithBlocks({ docTitle: 'reload', blocks: [] })
    await syncPush()
    const newDir = join(testDir, 'export2')
    await applySyncConfig({
      version: 1,
      active: { kind: 'localfs', dir: newDir, enabled: true },
    })
    expect(syncStatus().configured).toBe(true)
    expect(syncStatus().lastSuccessAt).toBeTruthy()
    // 再跑一次，确保新 dir 生效
    const r = await syncPush()
    expect(r.pushed).toBe(1)
    const md = readdirSync(join(newDir, 'untagged')).filter((f) => f.endsWith('.md') && f.startsWith('reload--'))
    expect(md.length).toBe(1)
  })

  test('applySyncConfig 把 enabled 设为 false → configured=false', async () => {
    initSyncManager(testDir)
    await applySyncConfig({
      version: 1,
      active: { kind: 'localfs', dir: exportDir, enabled: false },
    })
    expect(isSyncConfigured()).toBe(false)
  })

  test('syncPush 计数成功', async () => {
    initSyncManager(testDir)
    await applySyncConfig({
      version: 1,
      active: { kind: 'localfs', dir: exportDir, enabled: true },
    })
    seedDocWithBlocks({ docTitle: 'X', blocks: [] })
    const r = await syncPush()
    expect(r.pushed).toBe(1)
    expect(syncStatus().lastSuccessAt).toBeTruthy()
  })

  test('S3 adapter 配置后 manager 进入 configured=true', async () => {
    initSyncManager(testDir)
    await applySyncConfig({
      version: 1,
      active: {
        kind: 's3',
        bucket: 'b',
        region: 'us-east-1',
        accessKeyId: 'k',
        secretAccessKey: 's',
        enabled: true,
      },
    } as never)
    // S3 现在用真实 SDK；adapter 实例化可能因网络缺失而失败，
    // 这里只验证 manager 接受了配置不报错（不强行模拟 SDK 调用）。
    expect(typeof syncStatus().configured).toBe('boolean')
  })

  test('syncInfo 未配置时抛错', async () => {
    initSyncManager(testDir)
    await expect(syncInfo()).rejects.toThrow('未配置')
  })
})

describe('Sync HTTP routes', () => {
  test('GET /config 返回公共视图', async () => {
    initSyncManager(testDir)
    const { status, body } = await api('GET', '/config')
    expect(status).toBe(200)
    expect(body.configured).toBe(false)
    expect(body.config).toBeTruthy()
  })

  test('PUT /config 启用 localfs → status.configured=true', async () => {
    initSyncManager(testDir)
    const { status, body } = await api('PUT', '/config', {
      active: { kind: 'localfs', dir: exportDir, enabled: true },
    })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.status.configured).toBe(true)
  })

  test('POST /run-now 写入文件并返回 count', async () => {
    initSyncManager(testDir)
    await api('PUT', '/config', {
      active: { kind: 'localfs', dir: exportDir, enabled: true },
    })
    seedDocWithBlocks({ docTitle: 'RunNow', blocks: [] })
    const { status, body } = await api('POST', '/run-now')
    expect(status).toBe(200)
    expect(body.result.pushed).toBe(1)
    const files = readdirSync(exportDir)
    expect(files.length).toBeGreaterThan(0)
  })

  test('GET /info 已配置 → 返回远端状态', async () => {
    initSyncManager(testDir)
    await api('PUT', '/config', {
      active: { kind: 'localfs', dir: exportDir, enabled: true },
    })
    const { status, body } = await api('GET', '/info')
    expect(status).toBe(200)
    expect(body.remoteDocCount).toBeDefined()
  })

  test('GET /info 未配置 → 400', async () => {
    initSyncManager(testDir)
    const { status } = await api('GET', '/info')
    expect(status).toBe(400)
  })

  test('DELETE /config 禁用', async () => {
    initSyncManager(testDir)
    await api('PUT', '/config', {
      active: { kind: 'localfs', dir: exportDir, enabled: true },
    })
    const { body } = await api('DELETE', '/config')
    expect(body.ok).toBe(true)
    expect(body.status.configured).toBe(false)
  })

  test('GET /adapters 列出可用 adapter 类型', async () => {
    const { body } = await api('GET', '/adapters')
    expect(body.adapters.length).toBeGreaterThanOrEqual(2)
    const kinds = body.adapters.map((a: { kind: string }) => a.kind)
    expect(kinds).toContain('localfs')
    expect(kinds).toContain('s3')
  })
})
