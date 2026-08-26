import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb, getDb } from '../db'
import { initAssetStore, saveAsset } from '../assets/store'
import docs from '../api/docs'
import blocks from '../api/blocks'
import sharePublic from '../api/sharePublic'

let testDir: string
let app: Hono
let notebookId: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-share-test-'))
  const result = initDb(testDir)
  notebookId = result.notebookId
  initAssetStore(testDir)

  app = new Hono()
  app.route('/api/v1/docs', docs)
  app.route('/api/v1/blocks', blocks)
  app.route('/share', sharePublic)
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

async function api(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) init.body = JSON.stringify(body)
  const res = await app.fetch(new Request(`http://localhost${path}`, init))
  const json = await res.json().catch(() => null)
  return { status: res.status, body: json }
}

async function createDoc(title: string, markdown = ''): Promise<string> {
  const { status, body } = await api('POST', '/api/v1/docs', {
    notebook_id: notebookId,
    title,
    markdown,
  })
  expect(status).toBe(201)
  return body.id as string
}

describe('分享管理 API（/api/v1/docs/:id/share）', () => {
  test('未开启 → GET 返回 shared=false；开启后返回 token 与路径', async () => {
    const docId = await createDoc('分享测试文档', '正文内容')

    const before = await api('GET', `/api/v1/docs/${docId}/share`)
    expect(before.status).toBe(200)
    expect(before.body.shared).toBe(false)

    const enabled = await api('PUT', `/api/v1/docs/${docId}/share`)
    expect(enabled.status).toBe(200)
    expect(enabled.body.token).toMatch(/^[0-9a-f]{32}$/)
    expect(enabled.body.path).toBe(`/s/${enabled.body.token}`)

    const after = await api('GET', `/api/v1/docs/${docId}/share`)
    expect(after.body.shared).toBe(true)
    expect(after.body.token).toBe(enabled.body.token)
  })

  test('PUT 幂等：重复开启返回同一 token', async () => {
    const docId = await createDoc('幂等分享')
    const first = await api('PUT', `/api/v1/docs/${docId}/share`)
    const second = await api('PUT', `/api/v1/docs/${docId}/share`)
    expect(second.body.token).toBe(first.body.token)
  })

  test('对不存在文档操作 → 404', async () => {
    const ghost = crypto.randomUUID()
    expect((await api('GET', `/api/v1/docs/${ghost}/share`)).status).toBe(404)
    expect((await api('PUT', `/api/v1/docs/${ghost}/share`)).status).toBe(404)
    expect((await api('DELETE', `/api/v1/docs/${ghost}/share`)).status).toBe(404)
  })
})

describe('分享公开端点（/share/:token，无鉴权）', () => {
  test('公开树剥掉 properties.source（导入来源不外泄），渲染字段保留', async () => {
    const docId = await createDoc('带来源文档', '正文一段')
    // 手工给根块与子块注入 source（模拟导入溯源属性）
    const db = getDb()
    db.query(`UPDATE blocks SET properties = json_set(properties, '$.source', json_object('provider','webhook','external_id','https://internal.example.com/secret')) WHERE root_id = ?`).run(docId)
    const { body: share } = await api('PUT', `/api/v1/docs/${docId}/share`)

    const pub = await api('GET', `/share/${share.token}`)
    expect(pub.status).toBe(200)
    const treeJson = JSON.stringify(pub.body.doc)
    expect(treeJson).not.toContain('internal.example.com')
    expect(treeJson).not.toContain('"source"')
    // 渲染所需字段仍在（子块 content 保留）
    expect(pub.body.doc.children.some((b: { content: string }) => b.content === '正文一段')).toBe(true)
  })

  test('开启后公开可取 title + markdown；关闭后 404；重开新 token、旧链接 404', async () => {
    const docId = await createDoc('公开阅读', '第一段\n\n第二段')
    const { body: share1 } = await api('PUT', `/api/v1/docs/${docId}/share`)

    const pub = await api('GET', `/share/${share1.token}`)
    expect(pub.status).toBe(200)
    expect(pub.body.title).toBe('公开阅读')
    expect(pub.body.markdown).toContain('第一段')
    expect(pub.body.markdown).toContain('第二段')
    expect(pub.body.shared_at).toBeTruthy()
    // block 树随响应下发（分享页 BlockRenderer 渲染的数据源）
    expect(pub.body.doc?.type).toBe('document')
    expect(pub.body.doc?.children?.length).toBeGreaterThanOrEqual(1)

    // 关闭 → 立即 404
    await api('DELETE', `/api/v1/docs/${docId}/share`)
    expect((await api('GET', `/share/${share1.token}`)).status).toBe(404)

    // 重开 → 新 token；旧链接永久失效
    const { body: share2 } = await api('PUT', `/api/v1/docs/${docId}/share`)
    expect(share2.token).not.toBe(share1.token)
    expect((await api('GET', `/share/${share1.token}`)).status).toBe(404)
    expect((await api('GET', `/share/${share2.token}`)).status).toBe(200)
  })

  test('有效期：指定 7 天；到期后公开 404、管理端视为未分享、重开新 token', async () => {
    const docId = await createDoc('限时分享', '内容')

    // 默认永不过期
    const { body: s1 } = await api('PUT', `/api/v1/docs/${docId}/share`)
    expect(s1.expires_at).toBeNull()

    // 指定 7 天（以现在为起点）
    const before = Date.now()
    const { body: s2 } = await api('PUT', `/api/v1/docs/${docId}/share`, { expires_in_days: 7 })
    expect(s2.token).toBe(s1.token)
    expect(s2.expires_at).toBeTruthy()
    const expiryMs = new Date(s2.expires_at.replace(' ', 'T') + 'Z').getTime()
    expect(expiryMs - before).toBeGreaterThan(6 * 86_400_000)
    expect(expiryMs - before).toBeLessThan(8 * 86_400_000)

    // 非法取值 → 400
    expect((await api('PUT', `/api/v1/docs/${docId}/share`, { expires_in_days: 5 })).status).toBe(400)

    // 手工改成已过期 → 公开端点 404，管理端视为未分享（惰性清理）
    getDb().query(`UPDATE shares SET expires_at = '2020-01-01 00:00:00' WHERE doc_id = ?`).run(docId)
    expect((await api('GET', `/share/${s2.token}`)).status).toBe(404)
    const after = await api('GET', `/api/v1/docs/${docId}/share`)
    expect(after.body.shared).toBe(false)

    // 过期后重开 → 全新 token，旧链接保持 404
    const { body: s3 } = await api('PUT', `/api/v1/docs/${docId}/share`)
    expect(s3.token).not.toBe(s2.token)
    expect((await api('GET', `/share/${s2.token}`)).status).toBe(404)
    expect((await api('GET', `/share/${s3.token}`)).status).toBe(200)
  })

  test('有效期保持：不带 expires_in_days 的 PUT 不改既有 expires_at；null 切回永不过期', async () => {
    const docId = await createDoc('有效期保持')

    const { body: s1 } = await api('PUT', `/api/v1/docs/${docId}/share`, { expires_in_days: 30 })
    expect(s1.expires_at).toBeTruthy()

    // 重复空 PUT：token 与 expires_at 都保持
    const { body: s2 } = await api('PUT', `/api/v1/docs/${docId}/share`)
    expect(s2.token).toBe(s1.token)
    expect(s2.expires_at).toBe(s1.expires_at)

    // 显式 null：切回永不过期（token 不变）
    const { body: s3 } = await api('PUT', `/api/v1/docs/${docId}/share`, { expires_in_days: null })
    expect(s3.token).toBe(s1.token)
    expect(s3.expires_at).toBeNull()
  })

  test('inbox / archived / ai_exclude 文档也可分享（显式行为覆盖默认过滤）', async () => {
    const cases: Array<[string, (docId: string) => Promise<void>]> = [
      ['inbox', async () => {}],
      ['archived', async (docId) => { await api('PATCH', `/api/v1/docs/${docId}/status`, { status: 'archived' }) }],
      // ai_exclude：guardrail 要求显式确认（见下条测试），确认后即可分享
      ['ai_exclude', async (docId) => { await api('PATCH', `/api/v1/docs/${docId}/ai-exclude`, { ai_exclude: true }) }],
    ]
    for (const [label, setup] of cases) {
      const { body: created } = await api('POST', '/api/v1/docs', {
        notebook_id: notebookId,
        title: `特殊状态分享-${label}`,
        markdown: '内容',
        ...(label === 'inbox' ? { status: 'inbox' } : {}),
      })
      await setup(created.id as string)
      const { body: share } = await api('PUT', `/api/v1/docs/${created.id}/share`, { confirm_ai_exclude: true })
      const pub = await api('GET', `/share/${share.token}`)
      expect(pub.status).toBe(200)
      expect(pub.body.title).toBe(`特殊状态分享-${label}`)
    }
  })

  test('ai_exclude 文档首次开启分享需显式确认（409）；确认后可分享；已开启后调有效期不再要求', async () => {
    const docId = await createDoc('隐藏文档分享确认', '敏感内容')
    await api('PATCH', `/api/v1/docs/${docId}/ai-exclude`, { ai_exclude: true })

    // 无确认 → 409，不创建分享
    const denied = await api('PUT', `/api/v1/docs/${docId}/share`)
    expect(denied.status).toBe(409)
    expect(denied.body.error).toBe('ai_exclude_share_needs_confirm')
    expect((await api('GET', `/api/v1/docs/${docId}/share`)).body.shared).toBe(false)

    // 显式确认 → 正常开启，公开可读
    const enabled = await api('PUT', `/api/v1/docs/${docId}/share`, { confirm_ai_exclude: true })
    expect(enabled.status).toBe(200)
    expect((await api('GET', `/share/${enabled.body.token}`)).status).toBe(200)

    // 已开启后再 PUT（调整有效期）不重复要求确认
    const adjusted = await api('PUT', `/api/v1/docs/${docId}/share`, { expires_in_days: 7 })
    expect(adjusted.status).toBe(200)
    expect(adjusted.body.token).toBe(enabled.body.token)
  })

  test('删除文档级联清除分享：恢复后 shared=false，旧 token 保持 404', async () => {
    const docId = await createDoc('删除级联', '内容')
    const { body: share } = await api('PUT', `/api/v1/docs/${docId}/share`)
    expect((await api('GET', `/share/${share.token}`)).status).toBe(200)

    await api('DELETE', `/api/v1/docs/${docId}`)
    expect((await api('GET', `/share/${share.token}`)).status).toBe(404)

    // 恢复文档：分享不复活（shares 行已随删除清除）
    const restored = await api('POST', `/api/v1/blocks/${docId}/restore`)
    expect(restored.status).toBe(200)
    expect((await api('GET', `/api/v1/docs/${docId}`)).status).toBe(200)
    expect((await api('GET', `/api/v1/docs/${docId}/share`)).body.shared).toBe(false)
    expect((await api('GET', `/share/${share.token}`)).status).toBe(404)
  })

  test('归档级联关闭分享：公开链接立即 404；恢复为 note 不复活旧链接', async () => {
    const docId = await createDoc('归档级联', '内容')
    const { body: share } = await api('PUT', `/api/v1/docs/${docId}/share`)
    expect((await api('GET', `/share/${share.token}`)).status).toBe(200)

    const archived = await api('PATCH', `/api/v1/docs/${docId}/status`, { status: 'archived' })
    expect(archived.status).toBe(200)
    expect(archived.body.share_revoked).toBe(true)
    expect((await api('GET', `/share/${share.token}`)).status).toBe(404)
    expect((await api('GET', `/api/v1/docs/${docId}/share`)).body.shared).toBe(false)

    // 恢复为 note：分享不复活（与删除路径语义一致），且不再返回 share_revoked
    const restored = await api('PATCH', `/api/v1/docs/${docId}/status`, { status: 'note' })
    expect(restored.status).toBe(200)
    expect(restored.body.share_revoked).toBeUndefined()
    expect((await api('GET', `/share/${share.token}`)).status).toBe(404)
  })

  test('随机 token / 畸形 token → 404，不暴露存在性', async () => {
    expect((await api('GET', `/share/${'0'.repeat(32)}`)).status).toBe(404)
    expect((await api('GET', '/share/not-a-token')).status).toBe(404)
  })

  test('文档删除后分享链接 404', async () => {
    const docId = await createDoc('将被删除')
    const { body: share } = await api('PUT', `/api/v1/docs/${docId}/share`)
    expect((await api('GET', `/share/${share.token}`)).status).toBe(200)

    await api('DELETE', `/api/v1/docs/${docId}`)
    expect((await api('GET', `/share/${share.token}`)).status).toBe(404)
  })

  test('图片：被引用 asset 可取；未引用 / 无效 token → 404', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    const { meta } = saveAsset(png, 'image/png')

    const docId = await createDoc('带图文档', `配图\n\n![图](asset:${meta.id})`)
    const { body: share } = await api('PUT', `/api/v1/docs/${docId}/share`)

    const res = await app.fetch(new Request(`http://localhost/share/${share.token}/assets/${meta.id}`))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    // private：浏览器可按内容寻址永久缓存，但共享缓存（CDN/反代）不得留存，
    // 否则分享关闭后旧 URL 仍可从缓存读到图片
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable')

    // 未被此文档引用的其他 asset → 404（不退化为全站代理）
    const other = saveAsset(Buffer.from('89504e47', 'hex'), 'image/png')
    expect((await api('GET', `/share/${share.token}/assets/${other.meta.id}`)).status).toBe(404)

    // 无效 token → 404
    expect((await api('GET', `/share/${'1'.repeat(32)}/assets/${meta.id}`)).status).toBe(404)
  })
})
