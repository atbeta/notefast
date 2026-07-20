import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { createDocSchema, buildBlockTree, buildHeadingTree, blocksToMarkdown, parseMarkdownToBlocks, stripTitleHeading, updateDocMarkdownSchema, rowToBlock, readTagsFromProperties, getTagProvider } from '@notefast/core'
import type { BlockRow, DocSummary } from '@notefast/core'
import { getDb } from '../db'
import { fireAfterCreate, fireAfterUpdate, fireAfterDelete, fireAfterCreateMany, fireAfterDeleteMany } from '../services/hooks'

const docs = new Hono()

docs.get('/list', (c) => {
  const db = getDb()
  const notebookId = c.req.query('notebook_id') || ''
  const tag = (c.req.query('tag') || '').trim().toLowerCase()

  let rows: BlockRow[]
  if (notebookId) {
    rows = db
      .query('SELECT * FROM blocks WHERE type = ? AND notebook_id = ? ORDER BY updated_at DESC')
      .all('document', notebookId) as BlockRow[]
  } else {
    rows = db
      .query('SELECT * FROM blocks WHERE type = ? ORDER BY updated_at DESC')
      .all('document') as BlockRow[]
  }

  // ?tag=xxx 过滤：在 Node 端做匹配（数量小，不值得加 SQL JSON 函数）
  if (tag) {
    rows = rows.filter((r) => readTagsFromProperties(r.properties).includes(tag))
  }

  const summaries: DocSummary[] = rows.map((r) => ({
    id: r.id,
    title: r.content,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }))

  return c.json(summaries)
})

docs.get('/tree', (c) => {
  const db = getDb()
  const docId = c.req.query('doc_id')

  if (!docId) {
    return c.json({ error: 'bad_request', message: '缺少 doc_id 参数' }, 400)
  }

  const docRow = db.query('SELECT * FROM blocks WHERE id = ? AND type = ?').get(docId, 'document') as BlockRow | undefined
  if (!docRow) {
    return c.json({ error: 'not_found', message: `文档 ${docId} 不存在` }, 404)
  }

  const rows = fetchAllDescendants(db, docId)
  const allRows = [docRow, ...rows]
  const tree = buildBlockTree(allRows)

  if (tree.length === 0) {
    return c.json([])
  }

  const headings = buildHeadingTree(tree[0].children || [])
  return c.json(headings)
})

docs.get('/:id', (c) => {
  const db = getDb()
  const id = c.req.param('id')

  const docRow = db.query('SELECT * FROM blocks WHERE id = ? AND type = ?').get(id, 'document') as BlockRow | undefined
  if (!docRow) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }

  const rows = fetchAllDescendants(db, id)
  const allRows = [docRow, ...rows]
  const tree = buildBlockTree(allRows)

  return c.json(tree.length > 0 ? tree[0] : null)
})

docs.post('/', zValidator('json', createDocSchema), (c) => {
  const db = getDb()
  const input = c.req.valid('json')
  const docId = crypto.randomUUID()
  const now = new Date().toISOString()

  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'document', ?, 0, 0, ?, ?)`,
  ).run(docId, input.notebook_id, docId, input.title, now, now)

  const row = db.query('SELECT * FROM blocks WHERE id = ?').get(docId) as BlockRow
  fireAfterCreate(rowToBlock(row))
  return c.json({
    id: row.id,
    title: row.content,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }, 201)
})

docs.patch('/:id/tags', async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => ({}))) as { tags?: unknown }
  const rawTags = Array.isArray(body.tags) ? body.tags : []
  const newTags = rawTags.filter((t): t is string => typeof t === 'string').slice(0, 64)

  const docRow = db
    .query("SELECT * FROM blocks WHERE id = ? AND type = 'document'")
    .get(id) as BlockRow | undefined
  if (!docRow) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }

  const provider = getTagProvider()
  const updated = provider.setDocTags(docRow, newTags)
  db.query(
    "UPDATE blocks SET properties = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(updated.properties, id)

  const finalTags = provider.getDocTags(updated)
  const updatedRow = db.query('SELECT * FROM blocks WHERE id = ?').get(id) as BlockRow
  return c.json({
    doc_id: id,
    tags: finalTags,
    updated_at: updatedRow.updated_at,
  })
})

docs.delete('/:id', (c) => {
  const db = getDb()
  const id = c.req.param('id')

  const docRow = db.query('SELECT * FROM blocks WHERE id = ? AND type = ?').get(id, 'document') as BlockRow | undefined
  if (!docRow) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }

  const childIds = fetchAllDescendants(db, id)
  const allIds = [id, ...childIds.map((r) => r.id)]

  db.transaction(() => {
    for (const delId of allIds) {
      db.query('DELETE FROM block_refs WHERE source_id = ? OR target_id = ?').run(delId, delId)
    }
    const placeholders = allIds.map(() => '?').join(',')
    db.query(`DELETE FROM blocks WHERE id IN (${placeholders})`).run(...allIds)
  })()

  fireAfterDelete(id)
  return c.json({ deleted: true, count: allIds.length })
})

docs.put('/:id/markdown', zValidator('json', updateDocMarkdownSchema), (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const { markdown, title } = c.req.valid('json')

  const docRow = db.query('SELECT * FROM blocks WHERE id = ? AND type = ?').get(id, 'document') as BlockRow | undefined
  if (!docRow) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }

  const rawInputs = parseMarkdownToBlocks(markdown, docRow.notebook_id)
  // 剥离与标题重复的首个 H1（导出的 markdown 首行是 `# {标题}`，直接回解析会重复入库）
  const newTitle = title || docRow.content
  const inputs = stripTitleHeading(rawInputs, newTitle)

  // 收集旧子块 ID（事务外保留引用，事务后触发 afterDelete）
  const oldChildRows = fetchAllDescendants(db, id)
  const oldChildIds = oldChildRows.map((r) => r.id)
  // 收集新插入的 block rows（事务后 SELECT 拿到最终时间戳）
  const insertedIds: string[] = []

  db.transaction(() => {
    for (const delId of oldChildIds) {
      db.query('DELETE FROM block_refs WHERE source_id = ? OR target_id = ?').run(delId, delId)
    }
    if (oldChildIds.length > 0) {
      const placeholders = oldChildIds.map(() => '?').join(',')
      db.query(`DELETE FROM blocks WHERE id IN (${placeholders})`).run(...oldChildIds)
    }

    db.query("UPDATE blocks SET content = ?, updated_at = datetime('now') WHERE id = ?").run(newTitle, id)

    const now = new Date().toISOString()
    const idMap = new Map<string, string>()

    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i]
      const blockId = crypto.randomUUID()
      if (inp.id) idMap.set(inp.id, blockId)
      const parentId = inp.parent_id ? (idMap.get(inp.parent_id) ?? id) : id

      db.query(
        `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, properties, sort, level, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        blockId,
        docRow.notebook_id,
        parentId,
        id,
        inp.type,
        inp.content ?? '',
        JSON.stringify(inp.properties || {}),
        i,
        now,
        now,
      )
      insertedIds.push(blockId)
    }
  })()

  // Hook 触发（fire-and-forget）：删旧 → 增新 → 更 doc
  fireAfterDeleteMany(oldChildIds)
  if (insertedIds.length > 0) {
    const placeholders = insertedIds.map(() => '?').join(',')
    const newRows = db
      .query(`SELECT * FROM blocks WHERE id IN (${placeholders})`)
      .all(...insertedIds) as BlockRow[]
    fireAfterCreateMany(newRows.map(rowToBlock))
  }
  const updatedDocRow = db.query('SELECT * FROM blocks WHERE id = ?').get(id) as BlockRow
  fireAfterUpdate(rowToBlock(updatedDocRow))

  const rows = fetchAllDescendants(db, id)
  const tree = buildBlockTree([updatedDocRow, ...rows])
  return c.json({ doc: tree.length > 0 ? tree[0] : null })
})

docs.get('/:id/export/markdown', (c) => {
  const id = c.req.param('id')
  const db = getDb()

  const docRow = db.query('SELECT * FROM blocks WHERE id = ? AND type = ?').get(id, 'document') as BlockRow | undefined
  if (!docRow) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }

  const rows = fetchAllDescendants(db, id)
  const allRows = [docRow, ...rows]
  const tree = buildBlockTree(allRows)

  const markdown = blocksToMarkdown(tree)
  return c.json({ markdown })
})

function fetchAllDescendants(database: ReturnType<typeof getDb>, rootId: string): BlockRow[] {
  const rows: BlockRow[] = []
  const stack = [rootId]

  while (stack.length > 0) {
    const currentId = stack.pop()!
    const children = database
      .query('SELECT * FROM blocks WHERE parent_id = ? ORDER BY sort ASC')
      .all(currentId) as BlockRow[]
    for (const child of children) {
      rows.push(child)
      stack.push(child.id)
    }
  }

  return rows
}

export default docs
