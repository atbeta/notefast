/**
 * 实体 API（图谱数据层的人类视角）
 *
 * - GET /api/v1/entities?q=&limit=       实体列表（mention_count 倒序）
 * - GET /api/v1/entities/duplicates      近义重复候选（「可能重复」提示；不自动合并）
 * - POST /api/v1/entities/:id/merge      把 :id 合并进 target_id（target 存活）
 * - GET /api/v1/entities/:id             实体详情 + 提及（人类视角全量，不排除任何文档状态；
 *                                        ai_exclude 文档开启时已 purge 物理清理，天然安全）
 * - GET /api/v1/docs/:id/entities        本篇文档提及的实体（面板数据源）
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getDb } from '../db'
import { getLiveDocById } from '../store/blocks'
import { describeEntity } from '../ai/entityDescribe'
import { dictDescriptionFor } from '../termDict'
import {
  findPotentialDuplicates,
  getEntityById,
  listDocEntities,
  listEntities,
  listEntityMentions,
  mergeEntities,
  type EntityRow,
} from '../store/entities'

const BLOCK_SNIPPET_LEN = 120

const entities = new Hono()

/**
 * 有效描述：词典（用户声明）> AI 生成（entities.description）。description_source
 * 供 UI 标注来源徽标（dict/ai/null）。
 */
function withEffectiveDescription(e: { name: string; description?: string | null }): {
  description: string | null
  description_source: 'dict' | 'ai' | null
} {
  const dictDesc = dictDescriptionFor(e.name)
  return {
    description: dictDesc ?? e.description ?? null,
    description_source: dictDesc ? 'dict' : e.description ? 'ai' : null,
  }
}

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
      ...withEffectiveDescription(e),
    })),
  })
})

entities.get('/duplicates', (c) => {
  const db = getDb()
  const groups = findPotentialDuplicates(db, 8)
  const pick = (g: (typeof groups)[number]) => ({
    reason: g.reason,
    signal: g.signal,
    entities: [
      { id: g.a.id, display: g.a.display, kind: g.a.kind, mention_count: g.a.mention_count },
      { id: g.b.id, display: g.b.display, kind: g.b.kind, mention_count: g.b.mention_count },
    ],
  })
  return c.json({
    groups: groups.map(pick), // 兼容旧字段
    typo_groups: groups.filter((g) => g.signal === 'typo').map(pick),
    suggest_groups: groups.filter((g) => g.signal === 'substring').map(pick),
  })
})

/**
 * 自动合并拼写变体（signal=typo 的高置信候选）。
 * 由实体页加载时调用（有副作用，不挂在 GET 上）；substring 候选不在此列——
 * 子串包含可能是上下位而非同义，错误合并污染图谱代价大于漏合，留给词典声明。
 *
 * 合并方向：mention_count 大者存活；同 count 取名称长者（拼写变体通常更短，
 * qdrnt → qdrant）；再同取先创建者（rowid 小）。
 */
entities.post('/duplicates/auto-merge', (c) => {
  const db = getDb()
  const groups = findPotentialDuplicates(db, 8)
  const rowidOf = (id: string): number =>
    (db.query('SELECT rowid FROM entities WHERE id = ?').get(id) as { rowid: number } | undefined)
      ?.rowid ?? Number.MAX_SAFE_INTEGER
  const pickTarget = (x: EntityRow, y: EntityRow): EntityRow => {
    if (x.mention_count !== y.mention_count) return x.mention_count > y.mention_count ? x : y
    if (x.name.length !== y.name.length) return x.name.length > y.name.length ? x : y
    return rowidOf(x.id) <= rowidOf(y.id) ? x : y
  }
  const pairs: Array<{ from: string; into: string }> = []
  for (const g of groups) {
    if (g.signal !== 'typo') continue
    const target = pickTarget(g.a, g.b)
    const from = target === g.a ? g.b : g.a
    // mergeEntities 内部有实体存在性守卫：候选对可能引用了已被前一对合并掉的实体
    if (!getEntityById(db, from.id) || !getEntityById(db, target.id)) continue
    mergeEntities(db, from.id, target.id)
    pairs.push({ from: from.display, into: target.display })
  }
  return c.json({ merged: pairs.length, pairs })
})

/** 把 :id 合并进 target_id（target 存活；提及/别名迁移，from 删除） */
const mergeSchema = z.object({
  target_id: z.string().min(1),
})

entities.post('/:id/merge', zValidator('json', mergeSchema), (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const { target_id } = c.req.valid('json')
  if (id === target_id) {
    return c.json({ error: 'bad_request', message: '不能把实体合并到自身' }, 400)
  }
  const from = getEntityById(db, id)
  const target = getEntityById(db, target_id)
  if (!from) return c.json({ error: 'not_found', message: `实体 ${id} 不存在` }, 404)
  if (!target) return c.json({ error: 'not_found', message: `目标实体 ${target_id} 不存在` }, 404)
  mergeEntities(db, id, target_id)
  const merged = getEntityById(db, target_id)!
  return c.json({
    merged: {
      id: merged.id,
      display: merged.display,
      kind: merged.kind,
      mention_count: merged.mention_count,
    },
    removed_id: id,
  })
})

/** 手动（重新）生成实体描述：清旧值后立即调 LLM，返回新描述或 null */
entities.post('/:id/describe', async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  if (!getEntityById(db, id)) {
    return c.json({ error: 'not_found', message: `实体 ${id} 不存在` }, 404)
  }
  db.query('UPDATE entities SET description = NULL WHERE id = ?').run(id)
  const ok = await describeEntity(id)
  const after = getEntityById(db, id)
  return c.json({ regenerated: ok, description: after?.description ?? null })
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
      ...withEffectiveDescription(entity),
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
