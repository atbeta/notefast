/**
 * 实体 API（图谱数据层的人类视角）
 *
 * - GET /api/v1/entities?q=&limit=       实体列表（mention_count 倒序）
 * - GET /api/v1/entities/:id             实体详情 + 提及（人类视角全量，不排除任何文档状态；
 *                                        ai_exclude 文档开启时已 purge 物理清理，天然安全）
 * - GET /api/v1/docs/:id/entities        本篇文档提及的实体（面板数据源）
 */

import { Hono } from 'hono'
import { getDb } from '../db'
import { getLiveDocById } from '../store/blocks'
import { getEntityById, listDocEntities, listEntities, listEntityMentions } from '../store/entities'

const BLOCK_SNIPPET_LEN = 120

const entities = new Hono()

entities.get('/', (c) => {
  const db = getDb()
  const q = c.req.query('q') ?? ''
  const limitRaw = parseInt(c.req.query('limit') ?? '', 10)
  const limit = Number.isFinite(limitRaw) ? limitRaw : 50
  const rows = listEntities(db, { q, limit })
  return c.json({
    entities: rows.map((e) => ({
      id: e.id,
      name: e.name,
      display: e.display,
      kind: e.kind,
      mention_count: e.mention_count,
    })),
  })
})

entities.get('/:id', (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const entity = getEntityById(db, id)
  if (!entity) {
    return c.json({ error: 'not_found', message: `实体 ${id} 不存在` }, 404)
  }
  const mentions = listEntityMentions(db, id).map((m) => ({
    block_id: m.block_id,
    doc_id: m.doc_id,
    doc_title: m.doc_title ?? '',
    doc_status: m.doc_status ?? 'note',
    surface: m.surface,
    block_snippet: (m.block_content ?? '').slice(0, BLOCK_SNIPPET_LEN),
  }))
  return c.json({
    entity: {
      id: entity.id,
      name: entity.name,
      display: entity.display,
      kind: entity.kind,
      mention_count: entity.mention_count,
    },
    mentions,
  })
})

/** 本篇文档提及的实体（挂在 /api/v1/docs 下） */
export const docEntities = new Hono()

docEntities.get('/:id/entities', (c) => {
  const db = getDb()
  const id = c.req.param('id')
  if (!getLiveDocById(db, id)) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }
  const rows = listDocEntities(db, id)
  return c.json({
    entities: rows.map((e) => ({
      id: e.id,
      display: e.display,
      kind: e.kind,
      mention_count: e.mention_count,
      surface: e.surface,
    })),
  })
})

export default entities
