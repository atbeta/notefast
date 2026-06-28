import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { importMarkdownSchema, parseMarkdownToBlocks, rowToBlock } from '@notefast/core'
import type { BlockRow } from '@notefast/core'
import { getDb } from '../db'

const importRouter = new Hono()

importRouter.post('/markdown', zValidator('json', importMarkdownSchema), (c) => {
  const db = getDb()
  const input = c.req.valid('json')

  const inputs = parseMarkdownToBlocks(input.markdown, input.notebook_id)
  if (inputs.length === 0) {
    return c.json({ error: 'bad_request', message: '无法解析 Markdown 内容' }, 400)
  }

  const docId = crypto.randomUUID()
  const now = new Date().toISOString()
  const title = input.title || extractTitle(input.markdown) || '未命名文档'

  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'document', ?, 0, 0, ?, ?)`,
  ).run(docId, input.notebook_id, docId, title, now, now)

  const createdIds: string[] = [docId]

  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i]
    const blockId = crypto.randomUUID()
    const parentId: string | null = inp.parent_id ?? docId

    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, properties, sort, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      blockId,
      inp.notebook_id,
      parentId,
      docId,
      inp.type,
      inp.content ?? '',
      JSON.stringify(inp.properties || {}),
      0,
      now,
      now,
    )

    db.query('INSERT INTO blocks_fts (id, content) VALUES (?, ?)').run(blockId, inp.content || '')
    createdIds.push(blockId)
  }

  const docRow = db.query('SELECT * FROM blocks WHERE id = ?').get(docId) as BlockRow
  return c.json({ doc: rowToBlock(docRow), block_count: createdIds.length }, 201)
})

function extractTitle(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)/m)
  return match ? match[1].trim() : null
}

export default importRouter
