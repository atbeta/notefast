/**
 * 实体召回路 —— hybridSearch 的第四路 RRF 输入
 *
 * 思路：query 整句与各 term 对 entities.name 做 normalized 精确匹配（优先）+
 * LIKE 子串匹配（实体表规模小，LIKE 免费；CJK 无空格查询靠「实体名是查询子串」
 * 方向覆盖）→ 命中实体反查 entity_mentions → blocks。别名两路反查：词典别名经
 * resolveDictTerm 收敛到标准名（查「tape-out」命中标准实体「流片」）；实体别名
 * （合并遗留旧名，entity_aliases）经 resolveAlias 命中存活实体（查「qdrnt」命中
 * 已合并的「qdrant」）。
 *
 * 排序：精确匹配实体的块在前，其后按实体 mention_count 倒序；位置即 RRF rank。
 * 实体表为空或无命中时零成本短路。ai_exclude / inbox / archived 过滤在
 * hybridSearch 融合层与其他通道统一做，本路不重复过滤。
 */

import { getDb } from '../db'
import { fullToHalfWidth } from '@notefast/core'
import { resolveDictTerm } from '../termDict'
import { normalizeEntityName, resolveAlias } from '../store/entities'

export interface EntitySearchHit {
  block_id: string
  doc_id: string
  doc_title: string
  type: string
  content: string
  rrf_rank?: number
}

const DEFAULT_ENTITY_LIMIT = 20
/** LIKE 子串匹配的实体上限（防宽查询把整个实体表都拉进来） */
const MAX_MATCHED_ENTITIES = 20

interface MatchedEntity {
  id: string
  mention_count: number
  exact: boolean
}

function matchEntities(query: string): MatchedEntity[] {
  const db = getDb()
  const terms = query.split(/\s+/).filter(Boolean)

  // 候选名集合：查询整句 + 各 term + 词典反向（别名 → 标准名）。
  // 词典命中的别名 resolve 到标准名后参与精确/子串匹配——库里实体已按词典收敛为标准名，
  // 用户查「tape-out」要能命中标准实体「流片」。
  const names = new Set<string>()
  const addCandidate = (raw: string) => {
    const n = normalizeEntityName(fullToHalfWidth(raw))
    if (n.length >= 2) names.add(n)
    const resolved = resolveDictTerm(raw)
    if (resolved) names.add(resolved.name)
  }
  addCandidate(query)
  for (const t of terms) addCandidate(t)

  const byId = new Map<string, MatchedEntity>()

  // 精确匹配（规范化名）：优先级最高
  for (const name of names) {
    const row = db
      .query('SELECT id, mention_count FROM entities WHERE name = ?')
      .get(name) as { id: string; mention_count: number } | undefined
    if (row) byId.set(row.id, { ...row, exact: true })
  }

  // 实体别名反查（合并遗留旧名 → 存活实体）：alias 列存规范化名，与 names 同形态；
  // 与精确命中同级对待
  for (const name of names) {
    const entityId = resolveAlias(db, name)
    if (!entityId || byId.has(entityId)) continue
    const row = db
      .query('SELECT id, mention_count FROM entities WHERE id = ?')
      .get(entityId) as { id: string; mention_count: number } | undefined
    if (row) byId.set(row.id, { ...row, exact: true })
  }

  // 子串匹配（双向）：实体名含候选名，或候选名是查询整句的子串（CJK 无空格查询的召回主力）
  const likeParams: string[] = []
  const conds: string[] = []
  for (const n of names) {
    conds.push(`name LIKE ? ESCAPE '\\'`)
    likeParams.push(`%${escapeLike(n)}%`)
  }
  const full = normalizeEntityName(query)
  if (full.length >= 2) {
    conds.push(`? LIKE '%' || name || '%' ESCAPE '\\'`)
    likeParams.push(full)
  }
  if (conds.length > 0) {
    const rows = db
      .query(
        `SELECT id, mention_count FROM entities WHERE ${conds.join(' OR ')}
         ORDER BY mention_count DESC LIMIT ?`,
      )
      .all(...(likeParams as [string, ...string[]]), MAX_MATCHED_ENTITIES) as Array<{
      id: string
      mention_count: number
    }>
    for (const r of rows) {
      if (!byId.has(r.id)) byId.set(r.id, { ...r, exact: false })
    }
  }

  // 精确 > 子串，各自按 mention_count 倒序
  return [...byId.values()].sort((a, b) =>
    a.exact === b.exact ? b.mention_count - a.mention_count : a.exact ? -1 : 1,
  )
}

/** LIKE 字面量转义（与 lexicalSearch 同规则，配合 ESCAPE '\'） */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`)
}

export function entitySearch(query: string, limit = DEFAULT_ENTITY_LIMIT): EntitySearchHit[] {
  if (!query.trim() || limit <= 0) return []
  const db = getDb()
  // 实体表为空：零成本短路
  if (!db.query('SELECT 1 FROM entities LIMIT 1').get()) return []

  const matched = matchEntities(query)
  if (matched.length === 0) return []

  const hits: EntitySearchHit[] = []
  const seen = new Set<string>()
  for (const entity of matched) {
    if (hits.length >= limit) break
    const rows = db
      .query(
        `SELECT b.id, b.content, b.root_id, b.type, d.content AS doc_title
         FROM entity_mentions m
         JOIN blocks b ON b.id = m.block_id AND b.is_deleted = 0
         LEFT JOIN blocks d ON d.id = b.root_id
         WHERE m.entity_id = ?
         ORDER BY b.updated_at DESC`,
      )
      .all(entity.id) as Array<{
      id: string
      content: string
      root_id: string
      type: string
      doc_title: string | null
    }>
    for (const r of rows) {
      if (hits.length >= limit || seen.has(r.id)) continue
      seen.add(r.id)
      hits.push({
        block_id: r.id,
        doc_id: r.root_id,
        doc_title: r.doc_title ?? '',
        type: r.type,
        content: r.content,
      })
    }
  }
  return hits.map((h, i) => ({ ...h, rrf_rank: i + 1 }))
}
