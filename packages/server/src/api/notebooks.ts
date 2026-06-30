import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getDb } from '../db'

const notebooks = new Hono()

const createNotebookSchema = z.object({
  name: z.string().min(1).max(200),
  icon: z.string().optional().default(''),
})

const updateNotebookSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  icon: z.string().optional(),
})

notebooks.get('/', (c) => {
  const db = getDb()
  const rows = db.query('SELECT * FROM notebooks ORDER BY sort ASC, created_at ASC').all()
  return c.json(rows)
})

notebooks.get('/:id', (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const row = db.query('SELECT * FROM notebooks WHERE id = ?').get(id)
  if (!row) {
    return c.json({ error: 'not_found', message: `笔记本 ${id} 不存在` }, 404)
  }
  return c.json(row)
})

notebooks.post('/', zValidator('json', createNotebookSchema), (c) => {
  const db = getDb()
  const input = c.req.valid('json')
  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  db.query('INSERT INTO notebooks (id, name, icon, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    id, input.name, input.icon, now, now,
  )

  const row = db.query('SELECT * FROM notebooks WHERE id = ?').get(id)
  return c.json(row, 201)
})

notebooks.patch('/:id', zValidator('json', updateNotebookSchema), (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const input = c.req.valid('json')

  const existing = db.query('SELECT * FROM notebooks WHERE id = ?').get(id)
  if (!existing) {
    return c.json({ error: 'not_found', message: `笔记本 ${id} 不存在` }, 404)
  }

  const updates: string[] = []
  const params: (string | number)[] = []

  if (input.name !== undefined) {
    updates.push('name = ?')
    params.push(input.name)
  }
  if (input.icon !== undefined) {
    updates.push('icon = ?')
    params.push(input.icon)
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')")
    params.push(id)
    db.query(`UPDATE notebooks SET ${updates.join(', ')} WHERE id = ?`).run(
      ...params as [string, ...string[]],
    )
  }

  const row = db.query('SELECT * FROM notebooks WHERE id = ?').get(id)
  return c.json(row)
})

notebooks.delete('/:id', (c) => {
  const db = getDb()
  const id = c.req.param('id')

  const existing = db.query('SELECT * FROM notebooks WHERE id = ?').get(id)
  if (!existing) {
    return c.json({ error: 'not_found', message: `笔记本 ${id} 不存在` }, 404)
  }

  const { c: blockCount } = db.query('SELECT count(*) as c FROM blocks WHERE notebook_id = ?').get(id) as { c: number }

  db.transaction(() => {
    if (blockCount > 0) {
      db.query('DELETE FROM blocks WHERE notebook_id = ?').run(id)
    }
    db.query('DELETE FROM notebooks WHERE id = ?').run(id)
  })()

  return c.json({ deleted: true, blocks_deleted: blockCount })
})

export default notebooks
