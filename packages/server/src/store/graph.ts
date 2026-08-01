/**
 * 图谱查询 —— 实体共现图的节点选择与边计算
 *
 * 图谱 UI 的数据源：实体为节点、共现为边（两个实体在同一篇文档中被提及 → 边，
 * 权重 = 共享文档数）。实体↔文档的关系由 entity_mentions 表达，点击实体后的
 * 相关笔记走既有 GET /entities/:id，图端点不重复返回。
 *
 * 语义对齐实体页（人类视角）：不过滤 inbox / archived（与 /entities 页一致，
 * 人类探索图谱不隐藏任何生命周期状态）；ai_exclude 文档的实体开启时已物理
 * purge，天然不可见。
 *
 * **只反映当前内容**：全部查询过滤 `is_deleted = 0`（软删块的提及不算共现）。
 * 软删块上的提及是「删除后异步抽取竞态」的残留（afterCreate 抽取 fire-and-forget，
 * 文档在抽取完成前被整篇替换 → 替换清理先跑、抽取后到），不是合法数据；
 * 写入端 registerMentions / analyzeBlock 已加软删防护堵住竞态源头。
 * 真删除文档的提及由 store 级联物理清除，不残留。
 *
 * 节点选择（有中心时）：从锚点集合出发做 BFS 共现扩展（depth 跳），每跳按
 * mention_count 倒序填充到 maxNodes 预算；锚点本身不受 min_mention 过滤。
 * 无中心时：全库按 mention_count 取 top-N（min_mention + kind 过滤）。
 * 边：选中节点集合内部的共现对（同一文档），按权重倒序截断 max_edges。
 */

import type { getDb } from '../db'

export type Db = ReturnType<typeof getDb>

export type GraphCenter = { type: 'entity'; id: string } | { type: 'doc'; id: string }

export interface GraphNode {
  id: string
  name: string
  display: string
  kind: string
  mention_count: number
  /** 距锚点集合的跳数；无中心（总览）时恒为 0 */
  distance: number
}

export interface GraphEdge {
  source: string
  target: string
  /** 共享文档数（共现强度） */
  weight: number
}

export interface GraphQueryResult {
  nodes: GraphNode[]
  edges: GraphEdge[]
  center: GraphCenter | null
  /** 节点数达到预算被截断（前端可提示缩小范围） */
  truncated: boolean
}

export interface GraphQueryOptions {
  center?: GraphCenter
  /** BFS 扩展跳数，默认 2；无中心时忽略 */
  depth?: number
  /** 邻居实体最少提及次数（降噪），默认 2；锚点自身不受限 */
  minMention?: number
  /** 节点预算，默认 80，上限 300 */
  maxNodes?: number
  /** 边预算，默认 200，上限 500 */
  maxEdges?: number
  /** kind 过滤（空 = 不过滤） */
  kind?: string[]
}

export const GRAPH_LIMITS = {
  maxNodes: 300,
  maxEdges: 500,
  depth: 3,
  minMention: 100,
} as const

interface EntityRow {
  id: string
  name: string
  display: string
  kind: string
  mention_count: number
}

/**
 * 与 frontier 集合共现的实体（BFS 一跳）：
 * frontier 实体所在文档里的其他提及实体，过滤 min_mention / kind，排除已选集合。
 * 只统计活块上的提及（is_deleted = 0）——软删块提及是竞态残留，见文件头注释。
 */
function cooccurringEntities(
  db: Db,
  frontier: string[],
  opts: { exclude: Set<string>; minMention: number; kind: string[]; limit: number },
): EntityRow[] {
  const frontierPh = frontier.map(() => '?').join(',')
  const exclude = [...opts.exclude]
  const excludePh = exclude.length > 0 ? exclude.map(() => '?').join(',') : 'NULL'
  const kindCond =
    opts.kind.length > 0 ? ` AND e.kind IN (${opts.kind.map(() => '?').join(',')})` : ''

  // SQL 占位符顺序：frontier → minMention → exclude → kind → limit
  const args: (string | number)[] = [...frontier, opts.minMention, ...exclude, ...opts.kind, opts.limit]

  return db
    .query(
      `SELECT e.id, e.name, e.display, e.kind, e.mention_count
       FROM entity_mentions m
       JOIN (
         SELECT DISTINCT b2.id AS block_id
         FROM blocks b2
         WHERE b2.is_deleted = 0 AND b2.root_id IN (
           SELECT DISTINCT b1.root_id AS doc_id
           FROM entity_mentions hm
           JOIN blocks b1 ON b1.id = hm.block_id AND b1.is_deleted = 0
           WHERE hm.entity_id IN (${frontierPh})
         )
       ) hd ON hd.block_id = m.block_id
       JOIN entities e ON e.id = m.entity_id
       WHERE e.mention_count >= ? AND m.entity_id NOT IN (${excludePh})${kindCond}
       GROUP BY e.id
       ORDER BY e.mention_count DESC
       LIMIT ?`,
    )
    .all(...(args as [string | number, ...(string | number)[]])) as EntityRow[]
}

/** 选中集合内部的共现边（同一文档去重计数，仅活块），按权重倒序截断 */
function cooccurrenceEdges(db: Db, entityIds: string[], maxEdges: number): GraphEdge[] {
  if (entityIds.length < 2) return []
  const ph = entityIds.map(() => '?').join(',')
  const rows = db
    .query(
      `WITH ed AS (
         SELECT DISTINCT m.entity_id AS entity_id, b.root_id AS doc_id
         FROM entity_mentions m
         JOIN blocks b ON b.id = m.block_id AND b.is_deleted = 0
         WHERE m.entity_id IN (${ph})
       )
       SELECT a.entity_id AS source, b.entity_id AS target, COUNT(*) AS w
       FROM ed a JOIN ed b ON a.doc_id = b.doc_id AND a.entity_id < b.entity_id
       GROUP BY a.entity_id, b.entity_id
       ORDER BY w DESC, a.entity_id
       LIMIT ?`,
    )
    .all(...(entityIds as [string, ...string[]]), maxEdges) as Array<{
    source: string
    target: string
    w: number
  }>
  return rows.map((r) => ({ source: r.source, target: r.target, weight: r.w }))
}

/**
 * 查询共现图。
 * - center 为 entity：锚点 = 该实体（距离 0），BFS 扩展邻居。
 * - center 为 doc：锚点 = 该文档提及的全部实体（距离 0），再扩展。
 * - 无 center：全库 top-N（总览）。
 */
export function queryGraph(db: Db, opts: GraphQueryOptions = {}): GraphQueryResult {
  const depth = Math.max(1, Math.min(GRAPH_LIMITS.depth, opts.depth ?? 2))
  const minMention = Math.max(1, Math.min(GRAPH_LIMITS.minMention, opts.minMention ?? 2))
  const maxNodes = Math.max(2, Math.min(GRAPH_LIMITS.maxNodes, opts.maxNodes ?? 80))
  const maxEdges = Math.max(0, Math.min(GRAPH_LIMITS.maxEdges, opts.maxEdges ?? 200))
  const kind = opts.kind ?? []

  // 1. 锚点集合（距离 0）
  const dist = new Map<string, number>()
  if (opts.center?.type === 'entity') {
    dist.set(opts.center.id, 0)
  } else if (opts.center?.type === 'doc') {
    const rows = db
      .query(
        `SELECT DISTINCT m.entity_id AS id
         FROM entity_mentions m
         JOIN blocks b ON b.id = m.block_id AND b.is_deleted = 0
         WHERE b.root_id = ?`,
      )
      .all(opts.center.id) as Array<{ id: string }>
    for (const r of rows) dist.set(r.id, 0)
  }

  // 2. 总览模式：全库 top-N（无中心时）
  if (dist.size === 0) {
    const conds = ['e.mention_count >= ?']
    const args: (string | number)[] = [minMention]
    if (kind.length > 0) {
      conds.push(`e.kind IN (${kind.map(() => '?').join(',')})`)
      args.push(...kind)
    }
    args.push(maxNodes)
    const rows = db
      .query(
        `SELECT e.id, e.name, e.display, e.kind, e.mention_count
         FROM entities e
         WHERE ${conds.join(' AND ')}
         ORDER BY e.mention_count DESC, e.updated_at DESC
         LIMIT ?`,
      )
      .all(...(args as [string | number, ...(string | number)[]])) as EntityRow[]
    const nodes = rows.map((r) => ({ ...r, distance: 0 }))
    const edges = cooccurrenceEdges(db, nodes.map((n) => n.id), maxEdges)
    return { nodes, edges, center: opts.center ?? null, truncated: rows.length >= maxNodes }
  }

  // 3. 中心模式：BFS 共现扩展
  let frontier = [...dist.keys()]
  let curDist = 0
  while (frontier.length > 0 && dist.size < maxNodes && curDist < depth) {
    curDist++
    const next = cooccurringEntities(db, frontier, {
      exclude: new Set(dist.keys()),
      minMention,
      kind,
      limit: maxNodes - dist.size,
    })
    const added: string[] = []
    for (const r of next) {
      if (dist.size >= maxNodes) break
      dist.set(r.id, curDist)
      added.push(r.id)
    }
    if (added.length === 0) break
    frontier = added
  }
  const truncated = dist.size >= maxNodes

  const ids = [...dist.keys()]
  const nodeRows = db
    .query(
      `SELECT id, name, display, kind, mention_count FROM entities WHERE id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(...(ids as [string, ...string[]])) as EntityRow[]
  const nodes = nodeRows.map((r) => ({ ...r, distance: dist.get(r.id)! }))
  const edges = cooccurrenceEdges(db, ids, maxEdges)
  return { nodes, edges, center: opts.center ?? null, truncated }
}
