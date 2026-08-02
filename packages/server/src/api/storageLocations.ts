/**
 * 存储连接 API
 *
 * - GET    /api/v1/storage-locations        列出（密钥脱敏）
 * - POST   /api/v1/storage-locations        新建连接
 * - PUT    /api/v1/storage-locations/:id    更新连接
 * - DELETE /api/v1/storage-locations/:id    删除连接
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { storageLocationSchema } from '@notefast/core'
import {
  createStorageLocation,
  deleteStorageLocation,
  getPublicStorageLocation,
  getPublicStorageLocations,
  getStorageLocation,
  updateStorageLocation,
} from '../storage/locations'

const storageLocations = new Hono()

storageLocations.get('/', (c) => {
  return c.json({ locations: getPublicStorageLocations() })
})

storageLocations.post('/', zValidator('json', storageLocationSchema), (c) => {
  const body = c.req.valid('json')
  const loc = createStorageLocation({ ...body, id: '' })
  return c.json({ ok: true, location: getPublicStorageLocation(loc.id) }, 201)
})

storageLocations.put('/:id', zValidator('json', storageLocationSchema), (c) => {
  const id = c.req.param('id')
  const body = c.req.valid('json')
  const loc = updateStorageLocation(id, { ...body, id })
  if (!loc) {
    return c.json({ error: 'not_found', message: `连接 ${id} 不存在` }, 404)
  }
  return c.json({ ok: true, location: getPublicStorageLocation(id) })
})

storageLocations.delete('/:id', (c) => {
  const ok = deleteStorageLocation(c.req.param('id'))
  if (!ok) {
    return c.json({ error: 'not_found', message: '连接不存在' }, 404)
  }
  return c.json({ ok: true })
})

export default storageLocations

export { getStorageLocation }
