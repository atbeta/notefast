import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb } from '../db'
import blocks from '../api/blocks'
import docs from '../api/docs'
import search from '../api/search'
import importRouter from '../api/import'
import refs from '../api/refs'
import notebooks from '../api/notebooks'

let testDir: string
let app: Hono
let notebookId: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-api-test-'))
  const result = initDb(testDir)
  notebookId = result.notebookId

  app = new Hono()
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT'] }))
  app.route('/api/v1/blocks', blocks)
  app.route('/api/v1/docs', docs)
  app.route('/api/v1/search', search)
  app.route('/api/v1/import', importRouter)
  app.route('/api/v1/refs', refs)
  app.route('/api/v1/notebooks', notebooks)
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

async function api(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) init.body = JSON.stringify(body)
  const res = await app.fetch(new Request(`http://localhost${path}`, init))
  const json = await res.json()
  return { status: res.status, body: json }
}

describe('Notebooks API', () => {
  test('GET /api/v1/notebooks 列出笔记本', async () => {
    const { status, body } = await api('GET', '/api/v1/notebooks')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(1)
    expect(body[0].name).toBe('我的笔记')
  })

  test('POST /api/v1/notebooks 创建笔记本', async () => {
    const { status, body } = await api('POST', '/api/v1/notebooks', { name: '测试笔记本', icon: '📝' })
    expect(status).toBe(201)
    expect(body.name).toBe('测试笔记本')
    expect(body.icon).toBe('📝')
  })

  test('PATCH /api/v1/notebooks/:id 更新笔记本', async () => {
    const { body: created } = await api('POST', '/api/v1/notebooks', { name: '旧名称' })
    const { status, body } = await api('PATCH', `/api/v1/notebooks/${created.id}`, { name: '新名称' })
    expect(status).toBe(200)
    expect(body.name).toBe('新名称')
  })

  test('DELETE /api/v1/notebooks/:id 删除笔记本', async () => {
    const { body: created } = await api('POST', '/api/v1/notebooks', { name: '待删除' })
    const { status, body } = await api('DELETE', `/api/v1/notebooks/${created.id}`)
    expect(status).toBe(200)
    expect(body.deleted).toBe(true)
  })
})

describe('Blocks API', () => {
  test('POST /api/v1/blocks 创建 block', async () => {
    const { status, body } = await api('POST', '/api/v1/blocks', {
      notebook_id: notebookId,
      type: 'paragraph',
      content: '测试段落',
    })
    expect(status).toBe(201)
    expect(body.type).toBe('paragraph')
    expect(body.content).toBe('测试段落')
    expect(body.id).toBeDefined()
  })

  test('GET /api/v1/blocks/:id 获取 block', async () => {
    const { body: created } = await api('POST', '/api/v1/blocks', {
      notebook_id: notebookId,
      type: 'heading',
      content: '获取测试',
    })
    const { status, body } = await api('GET', `/api/v1/blocks/${created.id}`)
    expect(status).toBe(200)
    expect(body.content).toBe('获取测试')
  })

  test('PATCH /api/v1/blocks/:id 更新 block', async () => {
    const { body: created } = await api('POST', '/api/v1/blocks', {
      notebook_id: notebookId,
      type: 'paragraph',
      content: '原始内容',
    })
    const { status, body } = await api('PATCH', `/api/v1/blocks/${created.id}`, {
      content: '已更新',
    })
    expect(status).toBe(200)
    expect(body.content).toBe('已更新')
  })

  test('DELETE /api/v1/blocks/:id 删除 block', async () => {
    const { body: created } = await api('POST', '/api/v1/blocks', {
      notebook_id: notebookId,
      type: 'paragraph',
      content: '删除测试',
    })
    const { status, body } = await api('DELETE', `/api/v1/blocks/${created.id}`)
    expect(status).toBe(200)
    expect(body.deleted).toBe(true)
  })

  test('GET /api/v1/blocks/:id 不存在返回 404', async () => {
    const { status } = await api('GET', '/api/v1/blocks/nonexistent')
    expect(status).toBe(404)
  })
})

describe('Documents API', () => {
  test('POST /api/v1/docs 创建文档', async () => {
    const { status, body } = await api('POST', '/api/v1/docs', {
      notebook_id: notebookId,
      title: '新文档',
    })
    expect(status).toBe(201)
    expect(body.title).toBe('新文档')
  })

  test('GET /api/v1/docs/list 列出文档', async () => {
    await api('POST', '/api/v1/docs', { notebook_id: notebookId, title: '列表文档1' })
    await api('POST', '/api/v1/docs', { notebook_id: notebookId, title: '列表文档2' })

    const { status, body } = await api('GET', `/api/v1/docs/list?notebook_id=${notebookId}`)
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(2)
    expect(body[0].tags).toEqual([])
  })

  test('GET /api/v1/docs/list 支持 tags AND/OR / untagged / ai_exclude 字段', async () => {
    const { body: d1 } = await api('POST', '/api/v1/docs', { notebook_id: notebookId, title: '带标签A' })
    const { body: d2 } = await api('POST', '/api/v1/docs', { notebook_id: notebookId, title: '带标签B' })
    const { body: d3 } = await api('POST', '/api/v1/docs', { notebook_id: notebookId, title: '无标签文档xyz' })

    await api('PATCH', `/api/v1/docs/${d1.id}/tags`, { tags: ['work', 'ai'] })
    await api('PATCH', `/api/v1/docs/${d2.id}/tags`, { tags: ['life'] })

    const andRes = await api('GET', `/api/v1/docs/list?notebook_id=${notebookId}&tags=work,life`)
    expect(andRes.status).toBe(200)
    const andIds = (andRes.body as Array<{ id: string }>).map((d) => d.id)
    expect(andIds).not.toContain(d1.id)
    expect(andIds).not.toContain(d2.id)
    expect(andIds).not.toContain(d3.id)

    const orRes = await api('GET', `/api/v1/docs/list?notebook_id=${notebookId}&tags=work,life&tag_match=any`)
    expect(orRes.status).toBe(200)
    const orIds = (orRes.body as Array<{ id: string }>).map((d) => d.id)
    expect(orIds).toContain(d1.id)
    expect(orIds).toContain(d2.id)
    expect(orIds).not.toContain(d3.id)

    const bothRes = await api('GET', `/api/v1/docs/list?notebook_id=${notebookId}&tags=work,ai`)
    const bothIds = (bothRes.body as Array<{ id: string }>).map((d) => d.id)
    expect(bothIds).toContain(d1.id)
    expect(bothIds).not.toContain(d2.id)

    const untagged = await api('GET', `/api/v1/docs/list?notebook_id=${notebookId}&untagged=1`)
    expect(untagged.status).toBe(200)
    const unIds = (untagged.body as Array<{ id: string; tags: string[] }>).map((d) => d.id)
    expect(unIds).toContain(d3.id)
    expect(unIds).not.toContain(d1.id)

    await api('PATCH', `/api/v1/docs/${d1.id}/ai-exclude`, { ai_exclude: true })
    const list = await api('GET', `/api/v1/docs/list?notebook_id=${notebookId}&tags=work`)
    const row = (list.body as Array<{ id: string; ai_exclude?: boolean; tags: string[] }>).find((d) => d.id === d1.id)
    expect(row?.ai_exclude).toBe(true)
    expect(row?.tags).toContain('work')
  })
})

describe('Search API', () => {
  test('GET /api/v1/search 全文搜索', async () => {
    await api('POST', '/api/v1/blocks', {
      notebook_id: notebookId,
      type: 'paragraph',
      content: '搜索测试关键词 uniqueSearchTerm',
    })

    const { status, body } = await api('GET', '/api/v1/search?q=uniqueSearchTerm')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(1)
  })

  test('GET /api/v1/search/refs 反向链接', async () => {
    const { body: source } = await api('POST', '/api/v1/blocks', {
      notebook_id: notebookId,
      type: 'paragraph',
      content: '源块',
    })
    const { body: target } = await api('POST', '/api/v1/blocks', {
      notebook_id: notebookId,
      type: 'paragraph',
      content: '目标块',
    })

    await api('POST', '/api/v1/refs', { source_id: source.id, target_id: target.id })

    const { status, body } = await api('GET', `/api/v1/search/refs?target_id=${target.id}`)
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(1)
  })
})

describe('Import API', () => {
  test('POST /api/v1/import/markdown 导入 Markdown', async () => {
    const markdown = `# 导入测试

这是一段测试内容。

- 列表项1
- 列表项2`

    const { status, body } = await api('POST', '/api/v1/import/markdown', {
      notebook_id: notebookId,
      markdown,
    })

    expect(status).toBe(201)
    expect(body.doc).toBeDefined()
    expect(body.block_count).toBeGreaterThan(1)
  })
})

describe('Markdown Edit API', () => {
  test('PUT /api/v1/docs/:id/markdown 更新文档内容', async () => {
    const { body: doc } = await api('POST', '/api/v1/docs', {
      notebook_id: notebookId,
      title: '编辑前标题',
    })

    const newMarkdown = `## 新章节

更新后的段落内容。

\`\`\`js
const x = 1
\`\`\``

    const { status, body } = await api('PUT', `/api/v1/docs/${doc.id}/markdown`, {
      markdown: newMarkdown,
      title: '编辑后标题',
    })

    expect(status).toBe(200)
    expect(body.doc).toBeDefined()
    expect(body.doc.content).toBe('编辑后标题')

    const headings = body.doc.children.filter((c: { type: string }) => c.type === 'heading')
    expect(headings.length).toBe(1)
    expect(headings[0].content).toBe('新章节')
  })

  test('PUT /api/v1/docs/:id/markdown 缺少 markdown 返回 400', async () => {
    const { body: doc } = await api('POST', '/api/v1/docs', {
      notebook_id: notebookId,
      title: '测试文档',
    })

    const { status } = await api('PUT', `/api/v1/docs/${doc.id}/markdown`, { title: '空' })
    expect(status).toBe(400)
  })

  test('PUT /api/v1/docs/:id/markdown 不存在的文档返回 404', async () => {
    const { status } = await api('PUT', '/api/v1/docs/nonexistent/markdown', { markdown: '# test' })
    expect(status).toBe(404)
  })
})

describe('ai_exclude 一致性（API 路径）', () => {
  test('PATCH /api/v1/docs/:id/ai-exclude 返回 effect 字段', async () => {
    const { body: doc } = await api('POST', '/api/v1/docs', { notebook_id: notebookId, title: 'effect 测试' })
    const { status, body } = await api('PATCH', `/api/v1/docs/${doc.id}/ai-exclude`, { ai_exclude: true })
    expect(status).toBe(200)
    expect(body.ai_exclude).toBe(true)
    expect(body.effect).toBeDefined()
    expect(typeof body.effect.vectors).toBe('number')
  })

  test('PATCH /api/v1/blocks/:id 文档根的 ai_exclude 切换也触发 effect（与专用端点一致）', async () => {
    const { body: doc } = await api('POST', '/api/v1/docs', { notebook_id: notebookId, title: 'generic PATCH 测试' })
    // 通过通用 PATCH 设置 ai_exclude
    const { status, body } = await api('PATCH', `/api/v1/blocks/${doc.id}`, {
      properties: { ai_exclude: true },
    })
    expect(status).toBe(200)
    expect(body.properties.ai_exclude).toBe(true)
    // 专用端点确认已被设置
    const verify = await api('GET', `/api/v1/docs/list?notebook_id=${notebookId}`)
    const row = (verify.body as Array<{ id: string; ai_exclude?: boolean }>).find((d) => d.id === doc.id)
    expect(row?.ai_exclude).toBe(true)
  })

  test('GET /api/v1/search/refs 过滤来源属于 ai_exclude 文档的反链', async () => {
    // 创建一个普通文档并加两个块
    const { body: normalDoc } = await api('POST', '/api/v1/docs', { notebook_id: notebookId, title: 'ref-normal' })
    const { body: sourceA } = await api('POST', '/api/v1/blocks', {
      notebook_id: notebookId,
      type: 'paragraph',
      content: 'ref-source-A',
    })
    const { body: sourceB } = await api('POST', '/api/v1/blocks', {
      notebook_id: notebookId,
      type: 'paragraph',
      content: 'ref-source-B',
    })
    const { body: target } = await api('POST', '/api/v1/blocks', {
      notebook_id: notebookId,
      type: 'paragraph',
      content: 'ref-target',
    })
    await api('POST', '/api/v1/refs', { source_id: sourceA.id, target_id: target.id })
    await api('POST', '/api/v1/refs', { source_id: sourceB.id, target_id: target.id })

    // 初始两条都该出现
    const before = await api('GET', `/api/v1/search/refs?target_id=${target.id}`)
    expect((before.body as unknown[]).length).toBe(2)

    // 把 sourceA 移到 excluded 文档下：先创建 isolated doc、把 sourceA 通过 move 移过去，再标 exclude
    const { body: isolatedDoc } = await api('POST', '/api/v1/docs', {
      notebook_id: notebookId,
      title: 'ref-isolated',
    })
    await api('PATCH', `/api/v1/blocks/${sourceA.id}/move`, {
      new_parent_id: isolatedDoc.id,
    })
    await api('PATCH', `/api/v1/docs/${isolatedDoc.id}/ai-exclude`, { ai_exclude: true })

    const after = await api('GET', `/api/v1/search/refs?target_id=${target.id}`)
    const remaining = (after.body as Array<{ source_id: string }>).map((r) => r.source_id)
    expect(remaining).toEqual([sourceB.id])

    // 清理（可选）
    await api('PATCH', `/api/v1/docs/${isolatedDoc.id}/ai-exclude`, { ai_exclude: false })
    await api('PATCH', `/api/v1/blocks/${sourceA.id}/move`, {
      new_parent_id: normalDoc.id,
    })
  })
})
