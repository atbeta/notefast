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

  test('GET /api/v1/docs/list 默认排除收集箱；status=inbox 可列出', async () => {
    const { body: note } = await api('POST', '/api/v1/docs', {
      notebook_id: notebookId,
      title: '正式笔记xyz',
    })
    const { body: inbox } = await api('POST', '/api/v1/docs', {
      notebook_id: notebookId,
      title: '收集素材xyz',
      status: 'inbox',
      markdown: '一段剪藏',
    })
    expect(inbox.status).toBe('inbox')

    const main = await api('GET', `/api/v1/docs/list?notebook_id=${notebookId}`)
    const mainIds = (main.body as Array<{ id: string }>).map((d) => d.id)
    expect(mainIds).toContain(note.id)
    expect(mainIds).not.toContain(inbox.id)

    const box = await api('GET', `/api/v1/docs/list?notebook_id=${notebookId}&status=inbox`)
    const boxIds = (box.body as Array<{ id: string; status?: string }>).map((d) => d.id)
    expect(boxIds).toContain(inbox.id)
    expect(boxIds).not.toContain(note.id)

    await api('PATCH', `/api/v1/docs/${inbox.id}/status`, { status: 'note' })
    const after = await api('GET', `/api/v1/docs/list?notebook_id=${notebookId}`)
    expect((after.body as Array<{ id: string }>).map((d) => d.id)).toContain(inbox.id)
  })

  test('GET /api/v1/docs/list 默认排除归档；status=archived 可列出；可恢复', async () => {
    const { body: note } = await api('POST', '/api/v1/docs', {
      notebook_id: notebookId,
      title: '活跃笔记abc',
    })
    const { body: outdated } = await api('POST', '/api/v1/docs', {
      notebook_id: notebookId,
      title: '过时记录abc',
      markdown: '已修复的 Bug 记录',
    })

    // 归档
    const { status: patchStatus, body: patched } = await api('PATCH', `/api/v1/docs/${outdated.id}/status`, { status: 'archived' })
    expect(patchStatus).toBe(200)
    expect(patched.status).toBe('archived')

    // 默认列表不含归档
    const main = await api('GET', `/api/v1/docs/list?notebook_id=${notebookId}`)
    const mainIds = (main.body as Array<{ id: string }>).map((d) => d.id)
    expect(mainIds).toContain(note.id)
    expect(mainIds).not.toContain(outdated.id)

    // status=archived 只列归档，响应带 status 字段
    const box = await api('GET', `/api/v1/docs/list?notebook_id=${notebookId}&status=archived`)
    const boxRows = box.body as Array<{ id: string; status?: string }>
    expect(boxRows.map((d) => d.id)).toContain(outdated.id)
    expect(boxRows.map((d) => d.id)).not.toContain(note.id)
    expect(boxRows.find((d) => d.id === outdated.id)?.status).toBe('archived')

    // status=all 两者都在
    const all = await api('GET', `/api/v1/docs/list?notebook_id=${notebookId}&status=all`)
    const allIds = (all.body as Array<{ id: string }>).map((d) => d.id)
    expect(allIds).toContain(note.id)
    expect(allIds).toContain(outdated.id)

    // 恢复为 note 后回到默认列表
    await api('PATCH', `/api/v1/docs/${outdated.id}/status`, { status: 'note' })
    const after = await api('GET', `/api/v1/docs/list?notebook_id=${notebookId}`)
    expect((after.body as Array<{ id: string }>).map((d) => d.id)).toContain(outdated.id)
  })

  test('GET /api/v1/docs/:id/neighbors 与文档列表顺序一致', async () => {
    const { body: first } = await api('POST', '/api/v1/docs', { notebook_id: notebookId, title: '邻居甲' })
    const { body: middle } = await api('POST', '/api/v1/docs', { notebook_id: notebookId, title: '邻居乙' })
    const { body: last } = await api('POST', '/api/v1/docs', { notebook_id: notebookId, title: '邻居丙' })

    const listed = await api('GET', `/api/v1/docs/list?notebook_id=${notebookId}`)
    expect(listed.status).toBe(200)
    const ids = (listed.body as Array<{ id: string }>).map((d) => d.id)
    const idx = (id: string) => ids.indexOf(id)
    const neighborOf = (id: string) => ({
      prev: idx(id) > 0 ? ids[idx(id) - 1] : null,
      next: idx(id) >= 0 && idx(id) < ids.length - 1 ? ids[idx(id) + 1] : null,
    })

    const mid = await api('GET', `/api/v1/docs/${middle.id}/neighbors`)
    expect(mid.status).toBe(200)
    expect(mid.body.prev?.id ?? null).toBe(neighborOf(middle.id).prev)
    expect(mid.body.next?.id ?? null).toBe(neighborOf(middle.id).next)

    const head = await api('GET', `/api/v1/docs/${last.id}/neighbors`)
    expect(head.status).toBe(200)
    expect(head.body.prev?.id ?? null).toBe(neighborOf(last.id).prev)
    expect(head.body.next?.id ?? null).toBe(neighborOf(last.id).next)

    const tail = await api('GET', `/api/v1/docs/${first.id}/neighbors`)
    expect(tail.status).toBe(200)
    expect(tail.body.prev?.id ?? null).toBe(neighborOf(first.id).prev)
    expect(tail.body.next?.id ?? null).toBe(neighborOf(first.id).next)

    const missing = await api('GET', '/api/v1/docs/00000000-0000-4000-8000-000000000000/neighbors')
    expect(missing.status).toBe(404)
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

  test('GET /api/v1/docs/list?limit= 分页；无 limit 仍全量；ids 过滤', async () => {
    const { body: a } = await api('POST', '/api/v1/docs', { notebook_id: notebookId, title: '分页甲' })
    const { body: b } = await api('POST', '/api/v1/docs', { notebook_id: notebookId, title: '分页乙' })
    const { body: c } = await api('POST', '/api/v1/docs', { notebook_id: notebookId, title: '分页丙' })

    const full = await api('GET', `/api/v1/docs/list?notebook_id=${notebookId}&status=all`)
    expect(full.status).toBe(200)
    const fullIds = (full.body as Array<{ id: string }>).map((d) => d.id)
    expect(fullIds).toContain(a.id)
    expect(fullIds).toContain(b.id)
    expect(fullIds).toContain(c.id)

    const pageRes = await app.fetch(
      new Request(`http://localhost/api/v1/docs/list?notebook_id=${notebookId}&status=all&limit=2`),
    )
    expect(pageRes.status).toBe(200)
    const page = (await pageRes.json()) as Array<{ id: string }>
    expect(page.length).toBe(2)
    const cursor = pageRes.headers.get('X-Next-Cursor')
    expect(cursor).toBeTruthy()

    const page2Res = await app.fetch(
      new Request(
        `http://localhost/api/v1/docs/list?notebook_id=${notebookId}&status=all&limit=2&cursor=${encodeURIComponent(cursor!)}`,
      ),
    )
    const page2 = (await page2Res.json()) as Array<{ id: string }>
    expect(page2.length).toBeGreaterThan(0)
    const overlap = page2.filter((d) => page.some((p) => p.id === d.id))
    expect(overlap).toEqual([])

    const byIds = await api(
      'GET',
      `/api/v1/docs/list?status=all&ids=${encodeURIComponent(`${a.id},${c.id},deadbeef`)}`,
    )
    expect(byIds.status).toBe(200)
    const idSet = new Set((byIds.body as Array<{ id: string }>).map((d) => d.id))
    expect(idSet.has(a.id)).toBe(true)
    expect(idSet.has(c.id)).toBe(true)
    expect(idSet.has(b.id)).toBe(false)
    expect(idSet.size).toBe(2)
  })

  test('GET /api/v1/docs/list 带 shared 标记（仅有效分享；关闭后消失）', async () => {
    const { body: d1 } = await api('POST', '/api/v1/docs', { notebook_id: notebookId, title: '待分享文档' })
    const { body: d2 } = await api('POST', '/api/v1/docs', { notebook_id: notebookId, title: '未分享文档' })

    // 未分享时不带 shared 字段
    const before = await api('GET', `/api/v1/docs/list?notebook_id=${notebookId}`)
    const beforeRow = (before.body as Array<{ id: string; shared?: boolean }>).find((d) => d.id === d1.id)
    expect(beforeRow?.shared).toBeUndefined()

    // 开启分享后出现 shared: true，未分享文档不受影响
    const shareRes = await api('PUT', `/api/v1/docs/${d1.id}/share`, {})
    expect(shareRes.status).toBe(200)
    const after = await api('GET', `/api/v1/docs/list?notebook_id=${notebookId}`)
    const afterRows = after.body as Array<{ id: string; shared?: boolean }>
    expect(afterRows.find((d) => d.id === d1.id)?.shared).toBe(true)
    expect(afterRows.find((d) => d.id === d2.id)?.shared).toBeUndefined()

    // 关闭分享后标记消失
    await api('DELETE', `/api/v1/docs/${d1.id}/share`)
    const revoked = await api('GET', `/api/v1/docs/list?notebook_id=${notebookId}`)
    expect((revoked.body as Array<{ id: string; shared?: boolean }>).find((d) => d.id === d1.id)?.shared).toBeUndefined()
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
    const first = body[0] as { doc_title?: string }
    expect(typeof first.doc_title === 'string' || first.doc_title === undefined).toBe(true)
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

  test('GET /api/v1/search/refs 目标为文档根块时展开到文档内全部子块', async () => {
    const { body: doc } = await api('POST', '/api/v1/docs', {
      notebook_id: notebookId,
      title: '反链展开目标文档',
    })
    const { body: child } = await api('POST', '/api/v1/blocks', {
      notebook_id: notebookId,
      parent_id: doc.id,
      type: 'paragraph',
      content: '文档内的目标段落',
    })
    const { body: sourceDoc } = await api('POST', '/api/v1/docs', {
      notebook_id: notebookId,
      title: '引用方文档',
    })
    const { body: source } = await api('POST', '/api/v1/blocks', {
      notebook_id: notebookId,
      parent_id: sourceDoc.id,
      type: 'paragraph',
      content: '引用方段落',
    })

    await api('POST', '/api/v1/refs', { source_id: source.id, target_id: child.id })

    const { status, body } = await api('GET', `/api/v1/search/refs?target_id=${doc.id}`)
    expect(status).toBe(200)
    expect(body.length).toBe(1)
    expect(body[0].source_id).toBe(source.id)
    expect(body[0].target_id).toBe(child.id)
    expect(body[0].source_doc_title).toBe('引用方文档')
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

    // properties 必须随保存入库（headingLevel / language），否则标题层级与代码高亮/mermaid 渲染退化
    expect(headings[0].properties.headingLevel).toBe(2)
    const codes = body.doc.children.filter((c: { type: string }) => c.type === 'code')
    expect(codes.length).toBe(1)
    expect(codes[0].properties.language).toBe('js')

    // 再 GET 一次确认是持久化后的值，而非仅响应内组装
    const { body: fetched } = await api('GET', `/api/v1/docs/${doc.id}`)
    const fetchedHeading = fetched.children.find((c: { type: string }) => c.type === 'heading')
    expect(fetchedHeading.properties.headingLevel).toBe(2)
    const fetchedCode = fetched.children.find((c: { type: string }) => c.type === 'code')
    expect(fetchedCode.properties.language).toBe('js')
  })

  test('PUT /api/v1/docs/:id/markdown 空内容合法（删空重来）', async () => {
    const { body: doc } = await api('POST', '/api/v1/docs', {
      notebook_id: notebookId,
      title: '将被清空',
      markdown: '先有内容',
    })

    const { status, body } = await api('PUT', `/api/v1/docs/${doc.id}/markdown`, { markdown: '' })
    expect(status).toBe(200)
    // 文档回到空态：根块保留，子块清空
    expect(body.doc.children ?? []).toEqual([])

    // 持久化确认
    const { body: fetched } = await api('GET', `/api/v1/docs/${doc.id}`)
    expect(fetched.children ?? []).toEqual([])
  })

  test('PUT /api/v1/docs/:id/markdown 缺少 markdown 返回 400', async () => {    const { body: doc } = await api('POST', '/api/v1/docs', {
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

describe('Blocks move 传播', () => {
  test('跨文档同层移动（levelDiff=0）后代 root_id 同步更新', async () => {
    const { body: docA } = await api('POST', '/api/v1/docs', { notebook_id: notebookId, title: 'move-root-a' })
    const { body: docB } = await api('POST', '/api/v1/docs', { notebook_id: notebookId, title: 'move-root-b' })
    const { body: heading } = await api('POST', '/api/v1/blocks', {
      notebook_id: notebookId,
      parent_id: docA.id,
      type: 'heading',
      content: 'h',
    })
    const { body: child } = await api('POST', '/api/v1/blocks', {
      notebook_id: notebookId,
      parent_id: heading.id,
      type: 'paragraph',
      content: 'c',
    })
    expect(child.root_id).toBe(docA.id)

    // heading 从 docA 顶层移到 docB 顶层：level 不变（1→1），root 变（A→B）
    const { status } = await api('PATCH', `/api/v1/blocks/${heading.id}/move`, {
      new_parent_id: docB.id,
    })
    expect(status).toBe(200)

    const { body: movedHeading } = await api('GET', `/api/v1/blocks/${heading.id}`)
    expect(movedHeading.root_id).toBe(docB.id)
    const { body: movedChild } = await api('GET', `/api/v1/blocks/${child.id}`)
    expect(movedChild.root_id).toBe(docB.id)
    expect(movedChild.level).toBe(2)
  })

  test('循环父守卫：移到自身或后代下 → 400 invalid_params', async () => {
    const { body: doc } = await api('POST', '/api/v1/docs', { notebook_id: notebookId, title: 'move-cycle' })
    const { body: heading } = await api('POST', '/api/v1/blocks', {
      notebook_id: notebookId,
      parent_id: doc.id,
      type: 'heading',
      content: 'h',
    })
    const { body: child } = await api('POST', '/api/v1/blocks', {
      notebook_id: notebookId,
      parent_id: heading.id,
      type: 'paragraph',
      content: 'c',
    })

    // 移到自身下
    const self = await api('PATCH', `/api/v1/blocks/${heading.id}/move`, { new_parent_id: heading.id })
    expect(self.status).toBe(400)
    expect((self.body as { error: string }).error).toBe('invalid_params')

    // 移到自己的后代下
    const cycle = await api('PATCH', `/api/v1/blocks/${heading.id}/move`, { new_parent_id: child.id })
    expect(cycle.status).toBe(400)
    expect((cycle.body as { error: string }).error).toBe('invalid_params')

    // 结构未被破坏：父子关系保持原样
    const { body: unchanged } = await api('GET', `/api/v1/blocks/${child.id}`)
    expect(unchanged.parent_id).toBe(heading.id)
  })
})
