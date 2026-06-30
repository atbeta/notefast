import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getDb } from '../db'

const refs = new Hono()

const createRefSchema = z.object({
  source_id: z.string().min(1).max(200),
  target_id: z.string().min(1).max(200),
  ref_type: z.string().max(50).optional().default('link'),
})

refs.post('/', zValidator('json', createRefSchema), (c) => {
  const db = getDb()
  const { source_id, target_id, ref_type } = c.req.valid('json')

  const source = db.query('SELECT id FROM blocks WHERE id = ?').get(source_id)
  if (!source) {
    return c.json({ error: 'not_found', message: `源块 ${source_id} 不存在` }, 404)
  }

  const target = db.query('SELECT id FROM blocks WHERE id = ?').get(target_id)
  if (!target) {
    return c.json({ error: 'not_found', message: `目标块 ${target_id} 不存在` }, 404)
  }

  const existing = db
    .query('SELECT id FROM block_refs WHERE source_id = ? AND target_id = ?')
    .get(source_id, target_id)
  if (existing) {
    return c.json({ message: '引用关系已存在' }, 200)
  }

  db.query('INSERT INTO block_refs (source_id, target_id, ref_type) VALUES (?, ?, ?)').run(
    source_id,
    target_id,
    ref_type,
  )

  return c.json({ created: true }, 201)
})

refs.delete('/:id', (c) => {
  const db = getDb()
  const rawId = c.req.param('id')
  const id = parseInt(rawId, 10)
  if (!Number.isFinite(id) || id < 1) {
    return c.json({ error: 'bad_request', message: '无效的引用 ID' }, 400)
  }

  const result = db.query('DELETE FROM block_refs WHERE id = ?').run(id)
  if (result.changes === 0) {
    return c.json({ error: 'not_found', message: '引用关系不存在' }, 404)
  }

  return c.json({ deleted: true })
})

export default refs
