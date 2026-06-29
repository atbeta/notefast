import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { createDocSchema, buildBlockTree, buildHeadingTree, blocksToMarkdown, parseMarkdownToBlocks, updateDocMarkdownSchema } from '@notefast/core'
import type { BlockRow, DocSummary } from '@notefast/core'
import { getDb } from '../db'

const docs = new Hono()

docs.get('/list', (c) => {
  const db = getDb()
  const notebookId = c.req.query('notebook_id') || ''

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
  return c.json({
    id: row.id,
    title: row.content,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }, 201)
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

  for (const delId of allIds) {
    db.query('DELETE FROM block_refs WHERE source_id = ? OR target_id = ?').run(delId, delId)
  }

  const placeholders = allIds.map(() => '?').join(',')
  db.query(`DELETE FROM blocks WHERE id IN (${placeholders})`).run(...allIds)

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

  const childIds = fetchAllDescendants(db, id)
  const allChildIds = childIds.map((r) => r.id)

  for (const delId of allChildIds) {
    db.query('DELETE FROM block_refs WHERE source_id = ? OR target_id = ?').run(delId, delId)
  }
  if (allChildIds.length > 0) {
    const placeholders = allChildIds.map(() => '?').join(',')
    db.query(`DELETE FROM blocks WHERE id IN (${placeholders})`).run(...allChildIds)
  }

  const newTitle = title || docRow.content
  db.query("UPDATE blocks SET content = ?, updated_at = datetime('now') WHERE id = ?").run(newTitle, id)

  const inputs = parseMarkdownToBlocks(markdown, docRow.notebook_id)
  const now = new Date().toISOString()
  const idMap = new Map<string | null, string>()

  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i]
    const blockId = crypto.randomUUID()
    const parentId = inp.parent_id ? (idMap.get(inp.parent_id) ?? id) : id
    idMap.set(inp.parent_id ?? null, blockId)

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
  }

  const row = db.query('SELECT * FROM blocks WHERE id = ?').get(id) as BlockRow
  const rows = fetchAllDescendants(db, id)
  const tree = buildBlockTree([row, ...rows])
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
