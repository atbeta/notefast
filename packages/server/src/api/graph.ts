/**
 * 图谱 API —— 实体共现图 / 笔记关联图（图谱 UI 的数据源）
 *
 * - GET /api/v1/graph?mode=&center=&center_type=&depth=&min_mention=&max_nodes=&max_edges=&kind=
 *
 * mode = entities（默认，实体共现）| docs（笔记关联）。
 * center 为实体或文档 id（锚点，BFS 扩展邻居）；缺省 = 全库 top-N 总览。
 * min_mention 只约束邻居实体（锚点自身始终包含；docs 模式忽略）；kind 逗号分隔多值。
 * 语义与 /entities 页一致（人类视角，不隐藏 inbox/archived；ai_exclude 已 purge）。
 */

import { Hono } from 'hono'
import { getDb } from '../db'
import { getLiveDocById } from '../store/blocks'
import { getEntityById } from '../store/entities'
import { GRAPH_LIMITS, queryGraph, type GraphCenter, type GraphMode } from '../store/graph'

const graph = new Hono()

function clampInt(raw: number, fallback: number, min: number, max: number): number {
  return Number.isFinite(raw) ? Math.max(min, Math.min(max, raw)) : fallback
}

graph.get('/', (c) => {
  const db = getDb()
  const mode: GraphMode = c.req.query('mode') === 'docs' ? 'docs' : 'entities'
  const centerId = (c.req.query('center') ?? '').trim()
  const centerType = (c.req.query('center_type') ?? '').trim()

  let center: GraphCenter | undefined
  if (centerId) {
    if (centerType === 'entity') {
      if (mode === 'docs') {
        return c.json({ error: 'bad_request', message: 'docs 模式不支持实体锚点，请用 center_type=doc' }, 400)
      }
      if (!getEntityById(db, centerId)) {
        return c.json({ error: 'not_found', message: `实体 ${centerId} 不存在` }, 404)
      }
      center = { type: 'entity', id: centerId }
    } else if (centerType === 'doc') {
      if (!getLiveDocById(db, centerId)) {
        return c.json({ error: 'not_found', message: `文档 ${centerId} 不存在` }, 404)
      }
      center = { type: 'doc', id: centerId }
    } else {
      return c.json({ error: 'bad_request', message: 'center_type 必须为 entity 或 doc' }, 400)
    }
  } else if (centerType) {
    return c.json({ error: 'bad_request', message: 'center 未指定时 center_type 无意义' }, 400)
  }

  const depthRaw = parseInt(c.req.query('depth') ?? '', 10)
  const minMentionRaw = parseInt(c.req.query('min_mention') ?? '', 10)
  const maxNodesRaw = parseInt(c.req.query('max_nodes') ?? '', 10)
  const maxEdgesRaw = parseInt(c.req.query('max_edges') ?? '', 10)
  const kindRaw = c.req.query('kind') ?? ''
  const q = (c.req.query('q') ?? '').trim()

  const result = queryGraph(db, {
    mode,
    center,
    depth: clampInt(depthRaw, 2, 1, GRAPH_LIMITS.depth),
    minMention: clampInt(minMentionRaw, 2, 1, GRAPH_LIMITS.minMention),
    maxNodes: clampInt(maxNodesRaw, 80, 2, GRAPH_LIMITS.maxNodes),
    maxEdges: clampInt(maxEdgesRaw, 200, 0, GRAPH_LIMITS.maxEdges),
    kind: kindRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ...(q ? { q } : {}),
  })

  return c.json(result)
})

export default graph
