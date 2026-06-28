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
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PATCH', 'DELETE'] }))
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
