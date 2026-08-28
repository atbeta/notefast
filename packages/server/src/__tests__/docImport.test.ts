import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { blocksToMarkdown, buildBlockTree, readTags } from '@notefast/core'
import type { BlockRow } from '@notefast/core'
import { initDb, closeDb, getDb } from '../db'
import { fetchDocBlocks, getBlockById } from '../store/blocks'
import { insertDocFromMarkdown, appendMarkdownToDoc, findDocIdBySource } from '../services/docImport'

let testDir: string
let notebookId: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-docimport-test-'))
  const result = initDb(testDir)
  notebookId = result.notebookId
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

describe('appendMarkdownToDoc', () => {
  test('追加的 Markdown 解析为结构化 block 树（代码块/表格/标题/emoji）', () => {
    const db = getDb()
    const { docId } = insertDocFromMarkdown(db, {
      notebookId,
      title: '追加测试',
      markdown: '只有一段简单文本',
    })

    const { blockIds, parsedCount } = appendMarkdownToDoc(db, {
      docId,
      notebookId,
      markdown: [
        '## 补充章节',
        '',
        '含 emoji 的段落 🎉',
        '',
        '```ts',
        'const a = 1',
        '```',
        '',
        '| 列A | 列B |',
        '| --- | --- |',
        '| 1 | 2 |',
      ].join('\n'),
    })

    expect(parsedCount).toBeGreaterThan(1)
    expect(blockIds.length).toBe(parsedCount)

    const rows = db
      .query(`SELECT * FROM blocks WHERE root_id = ? AND is_deleted = 0 AND type != 'document' ORDER BY sort`)
      .all(docId) as BlockRow[]
    const types = rows.map((r) => r.type)
    expect(types).toContain('paragraph')
    expect(types).toContain('heading')
    expect(types).toContain('code')
    expect(types).toContain('table')

    // properties 保留（headingLevel / language），预览渲染依赖这些字段
    const heading = rows.find((r) => r.type === 'heading')!
    expect(JSON.parse(heading.properties).headingLevel).toBe(2)
    expect(heading.content).toBe('补充章节')
    const code = rows.find((r) => r.type === 'code')!
    expect(JSON.parse(code.properties).language).toBe('ts')
    expect(code.content).toBe('const a = 1')
    const para = rows.find((r) => r.type === 'paragraph' && r.content.includes('emoji'))!
    expect(para.content).toContain('🎉')
  })

  test('追加块 sort 接在现有子块之后，层级与嵌套正确', () => {
    const db = getDb()
    const { docId } = insertDocFromMarkdown(db, {
      notebookId,
      title: '排序测试',
      markdown: '第一段\n\n第二段',
    })

    appendMarkdownToDoc(db, {
      docId,
      notebookId,
      markdown: '## 章节\n\n章节下的段落',
    })

    const rows = db
      .query(`SELECT * FROM blocks WHERE root_id = ? AND is_deleted = 0 AND type != 'document' ORDER BY sort`)
      .all(docId) as BlockRow[]

    // 顶层块 sort 严格递增（追加的接在原有 0,1 之后）
    const topLevel = rows.filter((r) => r.parent_id === docId)
    expect(topLevel.map((r) => r.sort)).toEqual([0, 1, 2, 3])
    expect(topLevel[2].type).toBe('heading')
    expect(topLevel[2].content).toBe('章节')
    expect(topLevel[3].content).toBe('章节下的段落')
    expect(topLevel[3].level).toBe(1)

    // 缩进嵌套的列表项挂在父级下，level 递增
    appendMarkdownToDoc(db, {
      docId,
      notebookId,
      markdown: '- 父项\n  - 子项',
    })
    const rows2 = db
      .query(`SELECT * FROM blocks WHERE root_id = ? AND is_deleted = 0 AND type != 'document' ORDER BY sort`)
      .all(docId) as BlockRow[]
    const parent = rows2.find((r) => r.content === '父项')!
    const child = rows2.find((r) => r.content === '子项')!
    expect(child.parent_id).toBe(parent.id)
    expect(child.level).toBe(parent.level + 1)
  })

  test('追加后导出 Markdown 保留代码块与表格语法（round-trip）', () => {
    const db = getDb()
    const { docId } = insertDocFromMarkdown(db, {
      notebookId,
      title: '导出测试',
      markdown: '简单文本',
    })

    appendMarkdownToDoc(db, {
      docId,
      notebookId,
      markdown: '```js\nconsole.log(1)\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |',
    })

    const rows = fetchDocBlocks(db, docId)
    const tree = buildBlockTree(rows)
    const md = blocksToMarkdown(tree)
    expect(md).toContain('```js')
    expect(md).toContain('| a | b |')
  })
})

describe('来源溯源（连接器预留）', () => {
  test('带 source 创建后可按 (provider, external_id) 找回', () => {
    const db = getDb()
    const { docId } = insertDocFromMarkdown(db, {
      notebookId,
      title: '外部推入的文档',
      markdown: '内容',
      source: { provider: 'webhook', external_id: 'https://example.com/post/1', synced_at: '2026-07-26T00:00:00Z' },
    })

    expect(findDocIdBySource(db, 'webhook', 'https://example.com/post/1')).toBe(docId)
    // provider / external_id 不匹配时不误中
    expect(findDocIdBySource(db, 'rss', 'https://example.com/post/1')).toBeNull()
    expect(findDocIdBySource(db, 'webhook', 'https://example.com/post/2')).toBeNull()

    // 无 source 的文档不参与匹配
    const { docId: plainId } = insertDocFromMarkdown(db, {
      notebookId,
      title: '普通文档',
      markdown: '内容',
    })
    expect(plainId).not.toBe(docId)
    expect(findDocIdBySource(db, 'webhook', '')).toBeNull()
  })
})

describe('打开即导入去重（POST /import/markdown + source）', () => {
  async function post(app: import('hono').Hono, markdown: string, source?: { provider: string; external_id: string }) {
    return app.request('/import/markdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notebook_id: notebookId,
        title: 'A',
        markdown,
        status: 'inbox',
        ...(source ? { source } : {}),
      }),
    })
  }

  test('同 source+同内容 → deduplicated 返回既有文档；内容变了 → 新建且 source 身份移交最新篇', async () => {
    const { Hono } = await import('hono')
    const { default: importRouter } = await import('../api/import')
    const app = new Hono()
    app.route('/import', importRouter)
    const src = { provider: 'file-open', external_id: '/tmp/dedup-a.md' }

    const r1 = await post(app, '# A\n\n第一版', src)
    expect(r1.status).toBe(201)
    const doc1 = ((await r1.json()) as { doc: { id: string } }).doc.id

    // 重复打开同一文件：200 + deduplicated + 同一文档，不产生新文档
    const r2 = await post(app, '# A\n\n第一版', src)
    expect(r2.status).toBe(200)
    const body2 = (await r2.json()) as { doc: { id: string }; deduplicated?: boolean }
    expect(body2.deduplicated).toBe(true)
    expect(body2.doc.id).toBe(doc1)

    // 外部改过了内容：新建一篇（不覆盖应用内可能的编辑），source 身份移交新文档
    const r3 = await post(app, '# A\n\n第二版', src)
    expect(r3.status).toBe(201)
    const doc3 = ((await r3.json()) as { doc: { id: string } }).doc.id
    expect(doc3).not.toBe(doc1)
    expect(findDocIdBySource(getDb(), 'file-open', '/tmp/dedup-a.md')).toBe(doc3)
  })

  test('不带 source 的导入不去重（Web / MCP 导入路径行为不变）', async () => {
    const { Hono } = await import('hono')
    const { default: importRouter } = await import('../api/import')
    const app = new Hono()
    app.route('/import', importRouter)

    const r1 = await post(app, '# B\n\n同样的内容')
    const r2 = await post(app, '# B\n\n同样的内容')
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
    const id1 = ((await r1.json()) as { doc: { id: string } }).doc.id
    const id2 = ((await r2.json()) as { doc: { id: string } }).doc.id
    expect(id2).not.toBe(id1)
  })

  test('回收站中的既有导入不挡重新导入（findDocIdBySource 只看未删除）', async () => {
    const { Hono } = await import('hono')
    const { default: importRouter } = await import('../api/import')
    const app = new Hono()
    app.route('/import', importRouter)
    const src = { provider: 'file-open', external_id: '/tmp/dedup-deleted.md' }

    const r1 = await post(app, '# C\n\n内容', src)
    const doc1 = ((await r1.json()) as { doc: { id: string } }).doc.id
    const db = getDb()
    db.query('UPDATE blocks SET is_deleted = 1 WHERE id = ?').run(doc1)

    const r2 = await post(app, '# C\n\n内容', src)
    expect(r2.status).toBe(201) // 重新导入为新文档，而非 deduplicated
    const doc2 = ((await r2.json()) as { doc: { id: string } }).doc.id
    expect(doc2).not.toBe(doc1)
  })
})

describe('POST /import/markdown 打磨（notebook_id 可选 + tags normalize）', () => {
  async function buildApp() {
    const { Hono } = await import('hono')
    const { default: importRouter } = await import('../api/import')
    const app = new Hono()
    app.route('/import', importRouter)
    return app
  }

  test('缺省 notebook_id 成功入第一个笔记本', async () => {
    const app = await buildApp()
    const res = await app.request('/import/markdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '无笔记本导入', markdown: '# 无笔记本导入\n\n内容' }),
    })
    expect(res.status).toBe(201)
    const docId = ((await res.json()) as { doc: { id: string } }).doc.id
    const row = getBlockById(getDb(), docId)!
    expect(row.notebook_id).toBe(notebookId) // initDb 创建的默认（第一个）笔记本
  })

  test('显式给出不存在的 notebook_id → 400（与 /import/zip 一致）', async () => {
    const app = await buildApp()
    const res = await app.request('/import/markdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notebook_id: 'no-such-notebook', markdown: '内容' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('bad_request')
  })

  test('tags 入库前 normalize（"My Tag" → "my-tag"，同 POST /docs 语义）', async () => {
    const app = await buildApp()
    const res = await app.request('/import/markdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: '内容', tags: ['My Tag', 'UPPER', '已 有 连字符'] }),
    })
    expect(res.status).toBe(201)
    const docId = ((await res.json()) as { doc: { id: string } }).doc.id
    expect(readTags(getBlockById(getDb(), docId)!)).toEqual(['my-tag', 'upper', '已-有-连字符'])
  })

  test('file-open 形态回归：notebook_id + source、无 tags → 201', async () => {
    const app = await buildApp()
    const res = await app.request('/import/markdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notebook_id: notebookId,
        title: '外部打开',
        markdown: '# 外部打开\n\n内容',
        status: 'inbox',
        source: { provider: 'file-open', external_id: '/tmp/regression-file-open.md' },
      }),
    })
    expect(res.status).toBe(201)
    const docId = ((await res.json()) as { doc: { id: string } }).doc.id
    expect(findDocIdBySource(getDb(), 'file-open', '/tmp/regression-file-open.md')).toBe(docId)
  })

  test('/import/file 的 tags 同样 normalize（multipart 逗号分隔与 JSON 数组）', async () => {
    const app = await buildApp()

    const form = new FormData()
    form.append('file', new File(['# 文件导入\n\n内容'], 'note.md', { type: 'text/markdown' }))
    form.append('notebook_id', notebookId)
    form.append('tags', 'My Tag,UPPER')
    const res = await app.request('/import/file', { method: 'POST', body: form })
    expect(res.status).toBe(201)
    const docId = ((await res.json()) as { doc: { id: string } }).doc.id
    expect(readTags(getBlockById(getDb(), docId)!)).toEqual(['my-tag', 'upper'])

    const form2 = new FormData()
    form2.append('file', new File(['# 文件导入二\n\n内容'], 'note2.md', { type: 'text/markdown' }))
    form2.append('notebook_id', notebookId)
    form2.append('tags', '["Json Tag"]')
    const res2 = await app.request('/import/file', { method: 'POST', body: form2 })
    expect(res2.status).toBe(201)
    const docId2 = ((await res2.json()) as { doc: { id: string } }).doc.id
    expect(readTags(getBlockById(getDb(), docId2)!)).toEqual(['json-tag'])
  })
})

describe('insertDocFromMarkdown 的 frontmatter tags', () => {
  const yamlMarkdown = [
    '---',
    'tags:',
    '  - invented',
    '  - extra',
    '---',
    '',
    '一段正文',
  ].join('\n')

  test('导入默认读取 YAML tags', () => {
    const { docId } = insertDocFromMarkdown(getDb(), {
      notebookId,
      title: '导入带标',
      markdown: yamlMarkdown,
    })
    expect(readTags(getBlockById(getDb(), docId)!)).toEqual(['invented', 'extra'])
  })

  test('applyFrontmatterTags: false 忽略 YAML tags', () => {
    const { docId } = insertDocFromMarkdown(getDb(), {
      notebookId,
      title: 'AI 创建',
      markdown: yamlMarkdown,
      applyFrontmatterTags: false,
    })
    expect(readTags(getBlockById(getDb(), docId)!)).toEqual([])
  })

  test('显式 tags 覆盖 YAML，即使关闭 frontmatter', () => {
    const { docId } = insertDocFromMarkdown(getDb(), {
      notebookId,
      title: '用户指定',
      markdown: yamlMarkdown,
      tags: ['work'],
      applyFrontmatterTags: false,
    })
    expect(readTags(getBlockById(getDb(), docId)!)).toEqual(['work'])
  })
})

describe('insertDocFromMarkdown 的 frontmatter 时间', () => {
  const datedMarkdown = [
    '---',
    'tags: []',
    'created: "2024-03-01 08:15:00.000"',
    'modified: "2024-06-10 19:30:00.500"',
    'notefast_id: ignore-me',
    '---',
    '',
    '一段旧笔记',
  ].join('\n')

  test('导入把 created / modified 写回文档根', () => {
    const { docId } = insertDocFromMarkdown(getDb(), {
      notebookId,
      title: '旧笔记',
      markdown: datedMarkdown,
    })
    const row = getBlockById(getDb(), docId)!
    expect(row.created_at).toBe('2024-03-01 08:15:00.000')
    expect(row.updated_at).toBe('2024-06-10 19:30:00.500')
  })

  test('applyFrontmatterTags: false 不采用 YAML 时间', () => {
    const before = Date.now()
    const { docId } = insertDocFromMarkdown(getDb(), {
      notebookId,
      title: 'AI 创建带时间',
      markdown: datedMarkdown,
      applyFrontmatterTags: false,
    })
    const row = getBlockById(getDb(), docId)!
    expect(row.created_at).not.toBe('2024-03-01 08:15:00.000')
    expect(row.updated_at).not.toBe('2024-06-10 19:30:00.500')
    expect(new Date(row.created_at.replace(' ', 'T') + 'Z').getTime()).toBeGreaterThanOrEqual(before - 1000)
  })

  test('无法识别的时间戳回退为现在', () => {
    const { docId } = insertDocFromMarkdown(getDb(), {
      notebookId,
      title: '坏时间',
      markdown: [
        '---',
        'created: yesterday',
        'modified: soon',
        '---',
        '',
        '正文',
      ].join('\n'),
    })
    const row = getBlockById(getDb(), docId)!
    expect(row.created_at).not.toBe('yesterday')
    expect(row.updated_at).not.toBe('soon')
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} /)
  })
})
