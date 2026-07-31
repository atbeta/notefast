import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getDb } from '../db'

const pinnedViews = new Hono()

const pinSchema = z.object({
  name: z.string().min(1).max(50),
  query: z.string().min(1).max(500),
})

const renameSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  query: z.string().min(1).max(500).optional(),
})

pinnedViews.get('/', (c) => {
  const db = getDb()
  const rows = db.query('SELECT id, name, query, created_at FROM pinned_views ORDER BY created_at DESC').all() as Array<{
    id: string; name: string; query: string; created_at: string
  }>
  return c.json(rows)
})

pinnedViews.post('/', zValidator('json', pinSchema), (c) => {
  const db = getDb()
  const { name, query } = c.req.valid('json')

  const existing = db.query('SELECT id FROM pinned_views WHERE query = ?').get(query)
  if (existing) return c.json({ id: (existing as { id: string }).id }, 200)

  const id = crypto.randomUUID()
  db.query('INSERT INTO pinned_views (id, name, query) VALUES (?, ?, ?)').run(id, name, query)
  return c.json({ id, name, query }, 201)
})

pinnedViews.delete('/:id', (c) => {
  const db = getDb()
  const id = c.req.param('id')
  db.query('DELETE FROM pinned_views WHERE id = ?').run(id)
  return c.json({ deleted: true })
})

pinnedViews.patch('/:id', zValidator('json', renameSchema), (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const row = db.query('SELECT id FROM pinned_views WHERE id = ?').get(id) as { id: string } | undefined
  if (!row) return c.json({ error: 'not_found' }, 404)
  const { name, query } = c.req.valid('json')
  if (name !== undefined) db.query('UPDATE pinned_views SET name = ? WHERE id = ?').run(name, id)
  if (query !== undefined) db.query('UPDATE pinned_views SET query = ? WHERE id = ?').run(query, id)
  return c.json({ id, updated: true })
})

export default pinnedViews
