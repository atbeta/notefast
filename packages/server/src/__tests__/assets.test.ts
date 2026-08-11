/**
 * AssetStore 测试
 *
 * 覆盖：
 * - 上传/去重（id = sha256 内容寻址）
 * - 读取（mime、immutable 缓存、404）
 * - 引用对账（/check 与 import 的 missing_assets）
 * - 孤儿回收（引用扫描推导 + 宽限期）
 * - 显式删除（未引用可删；引用中 409）
 * - 会话 cookie 鉴权（<img> 场景，仅放行读）
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Hono } from 'hono'
import { initDb, closeDb, getDb } from '../db'
import { initAssetStore, readAsset, collectOrphanAssets, ORPHAN_GRACE_MS, setImageUploadConfig, saveAsset, maybeUploadToRemote, getAssetRemoteUrl, uploadSingleAsset } from '../assets/store'
import { initImageUploadConfig, applyImageUploadConfig, getImageUploadConfig } from '../services/imageUploadConfig'
import { authMiddleware, sessionTokenValue, SESSION_COOKIE } from '../middleware/auth'
import assetsRouter from '../api/assets'
import importRouter from '../api/import'

let testDir: string
let app: Hono

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-assets-'))
  initDb(testDir)
  initAssetStore(testDir)
  initImageUploadConfig(testDir)
  app = new Hono()
  app.route('/api/v1/assets', assetsRouter)
  app.route('/api/v1/import', importRouter)
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  getDb().query('DELETE FROM assets').run()
  getDb().query('DELETE FROM blocks').run()
  getDb().exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")
})

async function upload(buf: Buffer = PNG_BYTES, mime = 'image/png') {
  const res = await app.fetch(new Request('http://localhost/api/v1/assets', {
    method: 'POST',
    headers: { 'Content-Type': mime },
    body: new Uint8Array(buf),
  }))
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('AssetStore — 上传与去重', () => {
  test('上传成功：id = 内容 sha256，文件落盘 data/media', async () => {
    const { status, body } = await upload()
    expect(status).toBe(201)
    const expectedId = createHash('sha256').update(PNG_BYTES).digest('hex')
    expect(body.id).toBe(expectedId)
    expect(body.ref).toBe(`asset:${expectedId}`)
    expect(existsSync(join(testDir, 'media', expectedId))).toBe(true)
    expect(readAsset(expectedId)?.meta.mime).toBe('image/png')
  })

  test('同一内容重复上传 → dedup:true，不产生第二份', async () => {
    await upload()
    const { status, body } = await upload()
    expect(status).toBe(200)
    expect(body.dedup).toBe(true)
  })

  test('非图片类型 → 400', async () => {
    const { status } = await upload(Buffer.from('plain text'), 'text/plain')
    expect(status).toBe(400)
  })

  test('读取：mime 正确 + immutable 缓存；不存在 → 404', async () => {
    const { body } = await upload()
    const res = await app.fetch(new Request(`http://localhost/api/v1/assets/${body.id}`))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Cache-Control')).toContain('immutable')
    const bytes = Buffer.from(await res.arrayBuffer())
    expect(bytes.equals(PNG_BYTES)).toBe(true)

    const missing = await app.fetch(new Request('http://localhost/api/v1/assets/' + '0'.repeat(64)))
    expect(missing.status).toBe(404)
  })

  test('列表：返回 items/total，referenced 随正文引用变化', async () => {
    const empty = await app.fetch(new Request('http://localhost/api/v1/assets'))
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual({ items: [], total: 0 })

    const { body } = await upload()
    const id = body.id as string
    const listed = await app.fetch(new Request('http://localhost/api/v1/assets?limit=10'))
    const listBody = await listed.json() as {
      total: number
      items: Array<{ id: string; referenced: boolean; remote: boolean }>
    }
    expect(listBody.total).toBe(1)
    expect(listBody.items[0]!.id).toBe(id)
    expect(listBody.items[0]!.referenced).toBe(false)

    const nb = crypto.randomUUID()
    const docId = crypto.randomUUID()
    const now = new Date().toISOString()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    getDb().query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'document', ?, 0, 0, ?, ?)`,
    ).run(docId, nb, docId, 'Doc', now, now)
    getDb().query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'paragraph', ?, 0, 1, ?, ?)`,
    ).run(crypto.randomUUID(), nb, docId, docId, `见 ![](asset:${id})`, now, now)

    const listed2 = await app.fetch(new Request('http://localhost/api/v1/assets'))
    const listBody2 = await listed2.json() as { items: Array<{ referenced: boolean }> }
    expect(listBody2.items[0]!.referenced).toBe(true)
  })
})

describe('AssetStore — 引用对账', () => {
  test('/check 报告缺失的 asset id', async () => {
    const { body } = await upload()
    const res = await app.fetch(new Request('http://localhost/api/v1/assets/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [body.id as string, 'f'.repeat(64)] }),
    }))
    const data = await res.json() as { missing: string[] }
    expect(data.missing).toEqual(['f'.repeat(64)])
  })

  test('import 含悬空 asset 引用 → 响应带 missing_assets（不阻断）', async () => {
    const nb = getDb().query('SELECT id FROM notebooks LIMIT 1').get() as { id: string }
    const res = await app.fetch(new Request('http://localhost/api/v1/import/markdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notebook_id: nb.id,
        title: 'dangling',
        markdown: `# x\n\n![img](asset:${'e'.repeat(64)})\n`,
      }),
    }))
    expect(res.status).toBe(201)
    const data = await res.json() as { missing_assets?: string[] }
    expect(data.missing_assets).toEqual(['e'.repeat(64)])
  })
})

describe('AssetStore — 显式删除', () => {
  test('未引用 → DELETE 成功；被引用 → 409 in_use；缺失 → 404', async () => {
    const { body: free } = await upload(Buffer.from([1, 2, 3, 4, 5]), 'image/png')
    const freeId = free.id as string

    const { body: used } = await upload(Buffer.from([9, 8, 7, 6, 5]), 'image/png')
    const usedId = used.id as string
    const db = getDb()
    const now = new Date().toISOString()
    const docId = crypto.randomUUID()
    db.query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(docId, 'T')
    db.query(`INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
      VALUES (?, ?, NULL, ?, 'document', ?, 0, 0, ?, ?)`).run(docId, docId, docId, 'doc', now, now)
    db.query(`INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'paragraph', ?, 0, 1, ?, ?)`).run('p-del', docId, docId, docId, `![x](asset:${usedId})`, now, now)

    const ok = await app.fetch(new Request(`http://localhost/api/v1/assets/${freeId}`, { method: 'DELETE' }))
    expect(ok.status).toBe(200)
    expect(readAsset(freeId)).toBeNull()
    expect(existsSync(join(testDir, 'media', freeId))).toBe(false)

    const blocked = await app.fetch(new Request(`http://localhost/api/v1/assets/${usedId}`, { method: 'DELETE' }))
    expect(blocked.status).toBe(409)
    const blockedBody = await blocked.json() as { error: string }
    expect(blockedBody.error).toBe('in_use')
    expect(readAsset(usedId)).not.toBeNull()

    const missing = await app.fetch(new Request(`http://localhost/api/v1/assets/${'f'.repeat(64)}`, { method: 'DELETE' }))
    expect(missing.status).toBe(404)
  })
})

describe('AssetStore — 孤儿回收', () => {
  test('无引用且超宽限期 → 删除；被引用 / 年轻 → 保留', async () => {
    const db = getDb()
    const old = new Date(Date.now() - ORPHAN_GRACE_MS - 1000).toISOString()

    // 孤儿 A：老、无引用 → 应删
    const orphanA = 'a'.repeat(64)
    writeFileSync(join(testDir, 'media', orphanA), PNG_BYTES)
    db.query('INSERT INTO assets (id, mime, size, created_at) VALUES (?, ?, ?, ?)').run(orphanA, 'image/png', 12, old)

    // 孤儿 B：老，但被 block 引用 → 应留
    const orphanB = 'b'.repeat(64)
    writeFileSync(join(testDir, 'media', orphanB), PNG_BYTES)
    db.query('INSERT INTO assets (id, mime, size, created_at) VALUES (?, ?, ?, ?)').run(orphanB, 'image/png', 12, old)
    const now = new Date().toISOString()
    const docId = crypto.randomUUID()
    db.query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(docId, 'T')
    db.query(`INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
      VALUES (?, ?, NULL, ?, 'document', ?, 0, 0, ?, ?)`).run(docId, docId, docId, 'doc', now, now)
    db.query(`INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'paragraph', ?, 0, 1, ?, ?)`).run('p1', docId, docId, docId, `![x](asset:${orphanB})`, now, now)

    // 孤儿 C：无引用但未满宽限期 → 应留
    const { body: cBody } = await upload(Buffer.from([9, 9, 9, 9]), 'image/png')

    const result = collectOrphanAssets()
    expect(result.ids).toContain(orphanA)
    expect(result.ids).not.toContain(orphanB)
    expect(readAsset(orphanA)).toBeNull()
    expect(existsSync(join(testDir, 'media', orphanA))).toBe(false)
    expect(readAsset(orphanB)).not.toBeNull()
    expect(readAsset(cBody.id as string)).not.toBeNull()
  })
})

describe('AssetStore — 会话 cookie 鉴权', () => {
  test('AUTH_PASSWORD 启用时：合法 cookie 可读图片，无凭证 401，写操作不认 cookie', async () => {
    const prev = process.env.AUTH_PASSWORD
    process.env.AUTH_PASSWORD = 'test-pw'
    try {
      const secure = new Hono()
      secure.use('/api/*', authMiddleware)
      secure.route('/api/v1/assets', assetsRouter)

      const { body } = await upload()
      const id = body.id as string
      const token = sessionTokenValue()
      expect(token.length).toBe(64)

      // 无凭证 → 401
      const noAuth = await secure.fetch(new Request(`http://localhost/api/v1/assets/${id}`))
      expect(noAuth.status).toBe(401)

      // 合法 cookie → 200（GET 放行）
      const withCookie = await secure.fetch(new Request(`http://localhost/api/v1/assets/${id}`, {
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }))
      expect(withCookie.status).toBe(200)

      // 错误 cookie → 401
      const badCookie = await secure.fetch(new Request(`http://localhost/api/v1/assets/${id}`, {
        headers: { Cookie: `${SESSION_COOKIE}=${'0'.repeat(64)}` },
      }))
      expect(badCookie.status).toBe(401)

      // cookie 不能用于写操作
      const writeWithCookie = await secure.fetch(new Request('http://localhost/api/v1/assets', {
        method: 'POST',
        headers: { Cookie: `${SESSION_COOKIE}=${token}`, 'Content-Type': 'image/png' },
        body: PNG_BYTES,
      }))
      expect(writeWithCookie.status).toBe(401)
    } finally {
      if (prev === undefined) delete process.env.AUTH_PASSWORD
      else process.env.AUTH_PASSWORD = prev
    }
  })
})

describe('AssetStore — 图床上传（命令契约）', () => {
  test('自动模式：spawn 命令上传，URL 写回 remote_url；显示仍走本地读（200 字节）', async () => {
    // 命令契约：command [args...] <path> → stdout 每行一个 http(s) URL
    // 用真实 node 进程模拟图床命令（无外部依赖）
    setImageUploadConfig({
      version: 1,
      mode: 'auto',
      command: process.execPath,
      args: ['-e', 'console.log("https://img.example.test/abc.png")'],
      timeoutMs: 10_000,
    })

    const { meta } = saveAsset(PNG_BYTES, 'image/png')
    maybeUploadToRemote(meta.id)

    // 异步写回：轮询等待（上限 2s）
    let url: string | null = null
    for (let i = 0; i < 40; i++) {
      url = getAssetRemoteUrl(meta.id)
      if (url) break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(url).toBe('https://img.example.test/abc.png')

    // 显示不走 302（避免图床防盗链/跨域）：本地字节返回
    const res = await app.fetch(new Request(`http://localhost/api/v1/assets/${meta.id}`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  test('命令失败（非零退出）→ 静默降级本地，remote_url 为空、GET 仍 200', async () => {
    setImageUploadConfig({
      version: 1,
      mode: 'auto',
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
      timeoutMs: 5_000,
    })

    const { meta } = saveAsset(PNG_BYTES, 'image/png')
    maybeUploadToRemote(meta.id)
    await new Promise((r) => setTimeout(r, 300))

    expect(getAssetRemoteUrl(meta.id)).toBeNull()
    const res = await app.fetch(new Request(`http://localhost/api/v1/assets/${meta.id}`))
    expect(res.status).toBe(200)
  })

  test('stdout 无 http(s) URL → 视为失败，本地保留', async () => {
    setImageUploadConfig({
      version: 1,
      mode: 'auto',
      command: process.execPath,
      args: ['-e', 'console.log("not-a-url")'],
      timeoutMs: 5_000,
    })

    const { meta } = saveAsset(PNG_BYTES, 'image/png')
    maybeUploadToRemote(meta.id)
    await new Promise((r) => setTimeout(r, 300))

    expect(getAssetRemoteUrl(meta.id)).toBeNull()
  })

  test('mode=off → 不 spawn 命令', async () => {
    setImageUploadConfig({ version: 1, mode: 'off', command: 'should-not-run', args: [], timeoutMs: 5_000 })
    const { meta } = saveAsset(PNG_BYTES, 'image/png')
    maybeUploadToRemote(meta.id)
    await new Promise((r) => setTimeout(r, 200))
    expect(getAssetRemoteUrl(meta.id)).toBeNull()
  })

  test('上传配置 GET/PUT 端点：保存后回读一致', async () => {
    const put = await app.fetch(new Request('http://localhost/api/v1/assets/upload-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'auto', command: 'picfast', args: ['upload'], timeoutMs: 15000 }),
    }))
    expect(put.status).toBe(200)
    const saved = await put.json() as { mode: string; command: string; args: string[]; timeoutMs: number }
    expect(saved.mode).toBe('auto')
    expect(saved.command).toBe('picfast')

    const getRes = await app.fetch(new Request('http://localhost/api/v1/assets/upload-config'))
    const loaded = await getRes.json() as { mode: string }
    expect(loaded.mode).toBe('auto')
  })

  test('PUT 保存配置后 store 层同步生效：上传路径立即用新配置（回归：测试端点读 services、上传读 store，两层曾不同步）', async () => {
    // 先把 store 层复位为启动时状态（未配置）——模拟「保存配置后未重启」的旧 bug 场景
    setImageUploadConfig(null)

    // 仅走 API 保存（PUT 内部必须同步到 store 层，不允许手动 setImageUploadConfig 补漏）
    const put = await app.fetch(new Request('http://localhost/api/v1/assets/upload-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'auto',
        command: process.execPath,
        args: ['-e', 'console.log("https://img.example.test/regression.png")'],
        timeoutMs: 10_000,
      }),
    }))
    expect(put.status).toBe(200)

    // 上传路径直接可用：单图触发上传（同步等待），应成功并写回 remote_url
    const { meta } = saveAsset(PNG_BYTES, 'image/png')
    const outcome = await uploadSingleAsset(meta.id)
    expect(outcome.ok).toBe(true)
    expect(outcome.url).toBe('https://img.example.test/regression.png')
    expect(getAssetRemoteUrl(meta.id)).toBe('https://img.example.test/regression.png')
  })

  afterAll(() => {
    setImageUploadConfig(null)
  })
})

describe('AssetStore — 图床命令容错与错误可见性', () => {
  test('splitUploadCommand：带子命令的完整命令被拆分（含引号路径）', async () => {
    const { splitUploadCommand } = await import('../assets/store')
    expect(splitUploadCommand('D:\\Tools\\picfast.exe upload')).toEqual({
      command: 'D:\\Tools\\picfast.exe',
      preArgs: ['upload'],
    })
    expect(splitUploadCommand('"D:\\My Tools\\picfast.exe" upload --raw')).toEqual({
      command: 'D:\\My Tools\\picfast.exe',
      preArgs: ['upload', '--raw'],
    })
    expect(splitUploadCommand('picgo')).toEqual({ command: 'picgo', preArgs: [] })
    expect(splitUploadCommand('  ')).toEqual({ command: '', preArgs: [] })
  })

  test('命令失败 → upload_error 写回 assets 行，GET /upload-config 暴露最近失败', async () => {
    const { getDb } = await import('../db')
    setImageUploadConfig({
      version: 1,
      mode: 'auto',
      command: process.execPath,
      args: ['-e', 'process.exit(3)'],
      timeoutMs: 5_000,
    })

    const { meta } = saveAsset(PNG_BYTES, 'image/png')
    maybeUploadToRemote(meta.id)
    // 等待异步写回 upload_error
    let err: string | null = null
    for (let i = 0; i < 40; i++) {
      const row = getDb().query('SELECT upload_error FROM assets WHERE id = ?').get(meta.id) as { upload_error: string | null }
      if (row.upload_error) { err = row.upload_error; break }
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(err).not.toBeNull()
    expect(err).toContain('exit')

    const cfgRes = await app.fetch(new Request('http://localhost/api/v1/assets/upload-config'))
    const cfg = await cfgRes.json() as { last_error: { at: string; message: string } | null }
    expect(cfg.last_error?.message ?? null).toBe(err)
  })

  test('测试端点：命令可用返回 URL；未启用自动上传 → 400', async () => {
    // API 层读 services 配置（applyImageUploadConfig），store 层用于上传路径——两层同步设置
    applyImageUploadConfig({
      mode: 'auto',
      command: process.execPath,
      args: ['-e', 'console.log("https://img.example.test/ok.png")'],
      timeoutMs: 5_000,
    })
    setImageUploadConfig(getImageUploadConfig())
    const okRes = await app.fetch(new Request('http://localhost/api/v1/assets/upload-config/test', { method: 'POST' }))
    expect(okRes.status).toBe(200)
    const ok = await okRes.json() as { ok: boolean; url: string | null; stderr: string }
    expect(ok.ok).toBe(true)
    expect(ok.url).toBe('https://img.example.test/ok.png')

    applyImageUploadConfig({ mode: 'off' })
    setImageUploadConfig(getImageUploadConfig())
    const offRes = await app.fetch(new Request('http://localhost/api/v1/assets/upload-config/test', { method: 'POST' }))
    expect(offRes.status).toBe(400)
  })

  afterAll(() => {
    setImageUploadConfig(null)
  })
})

describe('AssetStore — 存量图片批量补传', () => {
  test('upload-missing：串行补传全部 remote_url IS NULL 的图片并写回', async () => {
    const { getDb } = await import('../db')
    const db = getDb()
    applyImageUploadConfig({
      mode: 'auto',
      command: process.execPath,
      args: ['-e', 'console.log("https://img.example.test/batch.png")'],
      timeoutMs: 5_000,
    })
    setImageUploadConfig(getImageUploadConfig())

    const { meta: a } = saveAsset(Buffer.from([1, 2, 3, 4]), 'image/png')
    saveAsset(Buffer.from([5, 6, 7, 8]), 'image/jpeg')

    const res = await app.fetch(new Request('http://localhost/api/v1/assets/upload-missing', { method: 'POST' }))
    expect(res.status).toBe(200)
    const body = await res.json() as { queued: number; running: boolean }
    expect(body.queued).toBe(2)
    expect(body.running).toBe(true)

    // 轮询等待批量完成
    const { getUploadBatchStatus } = await import('../assets/store')
    let status = getUploadBatchStatus()
    for (let i = 0; i < 100 && status.running; i++) {
      await new Promise((r) => setTimeout(r, 50))
      status = getUploadBatchStatus()
    }
    expect(status.running).toBe(false)
    expect(status.ok).toBe(2)
    expect(status.failed).toBe(0)

    const rowA = db.query('SELECT remote_url FROM assets WHERE id = ?').get(a.id) as { remote_url: string | null }
    expect(rowA.remote_url).toBe('https://img.example.test/batch.png')
  })

  test('未启用自动上传 → 400；重复触发返回 running', async () => {
    applyImageUploadConfig({ mode: 'off' })
    setImageUploadConfig(getImageUploadConfig())
    const off = await app.fetch(new Request('http://localhost/api/v1/assets/upload-missing', { method: 'POST' }))
    expect(off.status).toBe(400)

    // running 中重复触发 → queued 0 + running true
    applyImageUploadConfig({ mode: 'auto', command: process.execPath, args: ['-e', 'setTimeout(()=>{},2000)'], timeoutMs: 10_000 })
    setImageUploadConfig(getImageUploadConfig())
    saveAsset(Buffer.from([9, 9, 9]), 'image/png') // 造一张待补传的图
    const first = await app.fetch(new Request('http://localhost/api/v1/assets/upload-missing', { method: 'POST' }))
    expect((await first.json() as { running: boolean }).running).toBe(true)
    const second = await app.fetch(new Request('http://localhost/api/v1/assets/upload-missing', { method: 'POST' }))
    const dup = await second.json() as { queued: number; running: boolean }
    expect(dup.queued).toBe(0)
    expect(dup.running).toBe(true)
    // 等批量结束，避免影响后续测试
    const { getUploadBatchStatus } = await import('../assets/store')
    for (let i = 0; i < 100 && getUploadBatchStatus().running; i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    applyImageUploadConfig({ mode: 'off' })
    setImageUploadConfig(getImageUploadConfig())
  })
})

describe('AssetStore — 最近失败语义（成功后不再显示）', () => {
  test('失败尝试后跟一次成功上传 → last_error 为 null', async () => {
    const { getDb } = await import('../db')
    const db = getDb()
    applyImageUploadConfig({
      mode: 'auto',
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
      timeoutMs: 5_000,
    })
    setImageUploadConfig(getImageUploadConfig())
    const { meta } = saveAsset(Buffer.from([1, 1, 1, 1]), 'image/png')
    maybeUploadToRemote(meta.id)
    // 等失败写回
    for (let i = 0; i < 40; i++) {
      const row = db.query('SELECT upload_error FROM assets WHERE id = ?').get(meta.id) as { upload_error: string | null }
      if (row.upload_error) break
      await new Promise((r) => setTimeout(r, 50))
    }
    let cfg = await (await app.fetch(new Request('http://localhost/api/v1/assets/upload-config'))).json() as { last_error: unknown }
    expect(cfg.last_error).not.toBeNull()

    // 同图重新上传成功（模拟修复后重试同一内容 → dedup 命中但 maybeUploadToRemote 仍触发）
    applyImageUploadConfig({
      mode: 'auto',
      command: process.execPath,
      args: ['-e', 'console.log("https://img.example.test/fixed.png")'],
      timeoutMs: 5_000,
    })
    setImageUploadConfig(getImageUploadConfig())
    const { meta: again, dedup } = saveAsset(Buffer.from([1, 1, 1, 1]), 'image/png')
    expect(dedup).toBe(true)
    expect(again.id).toBe(meta.id)
    maybeUploadToRemote(meta.id)
    // 等成功写回（remote_url 非空）
    for (let i = 0; i < 40; i++) {
      const row = db.query('SELECT remote_url FROM assets WHERE id = ?').get(meta.id) as { remote_url: string | null }
      if (row.remote_url) break
      await new Promise((r) => setTimeout(r, 50))
    }
    cfg = await (await app.fetch(new Request('http://localhost/api/v1/assets/upload-config'))).json() as { last_error: unknown }
    expect(cfg.last_error).toBeNull()
  })

  afterAll(() => {
    applyImageUploadConfig({ mode: 'off' })
    setImageUploadConfig(null)
  })
})

describe('AssetStore — 单图状态与单图上传', () => {
  test('GET /assets/status 批量返回 remote/error', async () => {
    const { meta: a } = saveAsset(Buffer.from([7, 7, 7, 7]), 'image/png')
    applyImageUploadConfig({
      mode: 'auto',
      command: process.execPath,
      args: ['-e', 'console.log("https://img.example.test/single.png")'],
      timeoutMs: 5_000,
    })
    setImageUploadConfig(getImageUploadConfig())
    maybeUploadToRemote(a.id)
    for (let i = 0; i < 40; i++) {
      if (getAssetRemoteUrl(a.id)) break
      await new Promise((r) => setTimeout(r, 50))
    }
    const res = await app.fetch(new Request(`http://localhost/api/v1/assets/status?ids=${a.id},deadbeef`))
    const body = await res.json() as Record<string, { remote: boolean; error: string | null }>
    expect(body[a.id]?.remote).toBe(true)
    expect(body.deadbeef).toBeUndefined()
  })

  test('POST /assets/:id/upload 同步上传单图；未启用自动上传 → 400', async () => {
    applyImageUploadConfig({
      mode: 'auto',
      command: process.execPath,
      args: ['-e', 'console.log("https://img.example.test/single2.png")'],
      timeoutMs: 5_000,
    })
    setImageUploadConfig(getImageUploadConfig())
    const { meta } = saveAsset(Buffer.from([8, 8, 8, 8]), 'image/png')

    const ok = await app.fetch(new Request(`http://localhost/api/v1/assets/${meta.id}/upload`, { method: 'POST' }))
    expect(ok.status).toBe(200)
    const body = await ok.json() as { ok: boolean; url: string | null }
    expect(body.ok).toBe(true)
    expect(body.url).toBe('https://img.example.test/single2.png')
    expect(getAssetRemoteUrl(meta.id)).toBe('https://img.example.test/single2.png')

    applyImageUploadConfig({ mode: 'off' })
    setImageUploadConfig(getImageUploadConfig())
    const off = await app.fetch(new Request(`http://localhost/api/v1/assets/${meta.id}/upload`, { method: 'POST' }))
    expect(off.status).toBe(400)
  })

  afterAll(() => {
    applyImageUploadConfig({ mode: 'off' })
    setImageUploadConfig(null)
  })
})
