import { Hono } from 'hono'
import { getDb } from '../db'

const refs = new Hono()

refs.post('/', async (c) => {
  const db = getDb()
  const body = await c.req.json<{ source_id: string; target_id: string; ref_type?: string }>()

  if (!body.source_id || !body.target_id) {
    return c.json({ error: 'bad_request', message: '需要 source_id 和 target_id' }, 400)
  }

  const source = db.query('SELECT id FROM blocks WHERE id = ?').get(body.source_id)
  if (!source) {
    return c.json({ error: 'not_found', message: `源块 ${body.source_id} 不存在` }, 404)
  }

  const target = db.query('SELECT id FROM blocks WHERE id = ?').get(body.target_id)
  if (!target) {
    return c.json({ error: 'not_found', message: `目标块 ${body.target_id} 不存在` }, 404)
  }

  const existing = db
    .query('SELECT id FROM block_refs WHERE source_id = ? AND target_id = ?')
    .get(body.source_id, body.target_id)
  if (existing) {
    return c.json({ message: '引用关系已存在' }, 200)
  }

  db.query('INSERT INTO block_refs (source_id, target_id, ref_type) VALUES (?, ?, ?)').run(
    body.source_id,
    body.target_id,
    body.ref_type || 'link',
  )

  return c.json({ created: true }, 201)
})

refs.delete('/:id', (c) => {
  const db = getDb()
  const id = parseInt(c.req.param('id'), 10)

  const result = db.query('DELETE FROM block_refs WHERE id = ?').run(id)
  if (result.changes === 0) {
    return c.json({ error: 'not_found', message: '引用关系不存在' }, 404)
  }

  return c.json({ deleted: true })
})

export default refs
