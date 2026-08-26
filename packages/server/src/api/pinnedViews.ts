/**
 * REST：固定视图（侧栏「固定视图」）
 *
 * 业务在 services/pinnedViews.ts，与 MCP 共用。
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import {
  createPinnedView,
  deletePinnedView,
  listPinnedViews,
  PinnedViewError,
  updatePinnedView,
} from '../services/pinnedViews'

const pinnedViews = new Hono()

const pinSchema = z.object({
  name: z.string().min(1).max(50),
  query: z.string().min(1).max(500),
})

const renameSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  query: z.string().min(1).max(500).optional(),
})

function errorStatus(code: PinnedViewError['code']): 400 | 404 {
  return code === 'not_found' ? 404 : 400
}

pinnedViews.get('/', (c) => {
  return c.json(listPinnedViews())
})

pinnedViews.post('/', zValidator('json', pinSchema), (c) => {
  const { name, query } = c.req.valid('json')
  try {
    const { view, created } = createPinnedView({ name, query })
    return c.json({ id: view.id, name: view.name, query: view.query }, created ? 201 : 200)
  } catch (e) {
    if (e instanceof PinnedViewError) {
      return c.json({ error: e.code, message: e.message }, errorStatus(e.code))
    }
    throw e
  }
})

pinnedViews.delete('/:id', (c) => {
  deletePinnedView(c.req.param('id'))
  return c.json({ deleted: true })
})

pinnedViews.patch('/:id', zValidator('json', renameSchema), (c) => {
  try {
    const view = updatePinnedView(c.req.param('id'), c.req.valid('json'))
    return c.json({ id: view.id, updated: true })
  } catch (e) {
    if (e instanceof PinnedViewError) {
      return c.json({ error: e.code, message: e.message }, errorStatus(e.code))
    }
    throw e
  }
})

export default pinnedViews
