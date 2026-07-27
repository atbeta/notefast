import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getDb } from '../db'
import { blockExists } from '../store/blocks'
import { findRefByPair, insertRef, deleteRefById } from '../store/refs'

const refs = new Hono()

const createRefSchema = z.object({
  source_id: z.string().min(1).max(200),
  target_id: z.string().min(1).max(200),
  ref_type: z.string().max(50).optional().default('link'),
})

refs.post('/', zValidator('json', createRefSchema), (c) => {
  const db = getDb()
  const { source_id, target_id, ref_type } = c.req.valid('json')

  if (!blockExists(db, source_id)) {
    return c.json({ error: 'not_found', message: `源块 ${source_id} 不存在` }, 404)
  }

  if (!blockExists(db, target_id)) {
    return c.json({ error: 'not_found', message: `目标块 ${target_id} 不存在` }, 404)
  }

  if (findRefByPair(db, source_id, target_id)) {
    return c.json({ message: '引用关系已存在' }, 200)
  }

  insertRef(db, { sourceId: source_id, targetId: target_id, refType: ref_type })

  return c.json({ created: true }, 201)
})

refs.delete('/:id', (c) => {
  const db = getDb()
  const rawId = c.req.param('id')
  const id = parseInt(rawId, 10)
  if (!Number.isFinite(id) || id < 1) {
    return c.json({ error: 'bad_request', message: '无效的引用 ID' }, 400)
  }

  if (!deleteRefById(db, id)) {
    return c.json({ error: 'not_found', message: '引用关系不存在' }, 404)
  }

  return c.json({ deleted: true })
})

export default refs
