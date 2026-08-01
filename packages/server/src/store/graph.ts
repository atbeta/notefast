/**
 * 图谱查询 —— 实体共现图 / 笔记关联图的节点选择与边计算
 *
 * 两种模式（mode）：
 * - entities：实体为节点、共现为边（两个实体在同一篇文档中被提及 → 边，
 *   权重 = 共享文档数）。点击实体后的相关笔记走 GET /entities/:id。
 * - docs：笔记为节点、关联为边（两篇文档共享实体或经 block_refs(ai_auto) 互链 → 边，
 *   权重 = 共享实体数 + 引用数）。总览按「关联度」倒序（连接其它文档最多的笔记在前，
 *   关联度为 0 的孤立笔记按 updated_at 兜底补充）。
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
 * 节点选择（有中心时）：从锚点集合出发做 BFS 扩展（depth 跳），每跳按
 * mention_count / 关联度倒序填充到 maxNodes 预算；锚点本身不受过滤。
 * 无中心时：全库 top-N（entities 按 mention_count；docs 按关联度）。
 * 边：选中节点集合内部的关系对，按权重倒序截断 max_edges。
 */

import type { getDb } from '../db'

export type Db = ReturnType<typeof getDb>

export type GraphMode = 'entities' | 'docs'

export type GraphCenter = { type: 'entity'; id: string; label?: string } | { type: 'doc'; id: string; label?: string }

export interface GraphNode {
  id: string
  name: string
  display: string
  /** entity = 实体（kind 着色）；doc = 笔记节点 */
  type: 'entity' | 'doc'
  kind: string
  /** entities 模式 = 提及次数；docs 模式 = 活块数（节点大小代理） */
  mention_count: number
  /** 距锚点集合的跳数；无中心（总览）时恒为 0 */
  distance: number
}

export interface GraphEdge {
  source: string
  target: string
  /** entities：共享文档数；docs：共享实体 + 引用数（关联强度） */
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
  mode?: GraphMode
  center?: GraphCenter
  /** BFS 扩展跳数，默认 2；无中心时忽略 */
  depth?: number
  /** 邻居实体最少提及次数（降噪），默认 2；锚点自身不受限；docs 模式忽略 */
  minMention?: number
  /** 节点预算，默认 80，上限 300 */
  maxNodes?: number
  /** 边预算，默认 200，上限 500 */
  maxEdges?: number
  /** kind 过滤（空 = 不过滤）；docs 模式忽略 */
  kind?: string[]
  /** docs 模式：总览按标题子串过滤（聚焦搜索用）；entities 模式忽略 */
  q?: string
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

interface DocRow {
  id: string
  title: string
  blocks: number
  updated_at: string
}

/** 解析锚点展示名（实体 display / 文档标题），供前端顶栏显示 */
function resolveCenterLabel(db: Db, center: GraphCenter): GraphCenter {
  if (center.type === 'entity') {
    const e = db.query('SELECT display FROM entities WHERE id = ?').get(center.id) as
      | { display?: string }
      | undefined
    return { ...center, label: e?.display }
  }
  const row = db.query('SELECT content FROM blocks WHERE id = ?').get(center.id) as
    | { content?: string }
    | undefined
  return { ...center, label: row?.content }
}

// ───────────────────── entities 模式 ─────────────────────

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

function queryEntityGraph(db: Db, opts: GraphQueryOptions): GraphQueryResult {
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

  const center = opts.center ? resolveCenterLabel(db, opts.center) : null

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
    const nodes: GraphNode[] = rows.map((r) => ({ ...r, type: 'entity', distance: 0 }))
    const edges = cooccurrenceEdges(db, nodes.map((n) => n.id), maxEdges)
    return { nodes, edges, center, truncated: rows.length >= maxNodes }
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
  const nodes: GraphNode[] = nodeRows.map((r) => ({ ...r, type: 'entity', distance: dist.get(r.id)! }))
  const edges = cooccurrenceEdges(db, ids, maxEdges)
  return { nodes, edges, center, truncated }
}

// ───────────────────── docs 模式 ─────────────────────

/** 与 frontier 文档直接关联的其它文档（共享实体 或 block_refs 互链），BFS 一跳 */
function neighboringDocs(
  db: Db,
  frontier: string[],
  opts: { exclude: Set<string>; limit: number },
): string[] {
  const ph = frontier.map(() => '?').join(',')
  const exclude = [...opts.exclude]
  const excludePh = exclude.length > 0 ? exclude.map(() => '?').join(',') : 'NULL'
  // 占位符顺序：frontier（共享实体内层）→ frontier（ref 出边）→ frontier（ref 入边）→ exclude → limit
  const args: (string | number)[] = [...frontier, ...frontier, ...frontier, ...exclude, opts.limit]
  const rows = db
    .query(
      `SELECT doc_id FROM (
         -- 共享实体：frontier 文档的实体出现在其它活文档
         SELECT DISTINCT b.root_id AS doc_id
         FROM entity_mentions m
         JOIN blocks b ON b.id = m.block_id AND b.is_deleted = 0
         WHERE m.entity_id IN (
           SELECT DISTINCT m2.entity_id
           FROM entity_mentions m2
           JOIN blocks b2 ON b2.id = m2.block_id AND b2.is_deleted = 0
           WHERE b2.root_id IN (${ph})
         )
         UNION
         -- ref 出边：frontier 文档的块引用其它文档的块
         SELECT t.root_id AS doc_id
         FROM block_refs r
         JOIN blocks s ON s.id = r.source_id AND s.is_deleted = 0 AND s.root_id IN (${ph})
         JOIN blocks t ON t.id = r.target_id AND t.is_deleted = 0
         UNION
         -- ref 入边：其它文档的块引用 frontier 文档的块
         SELECT s.root_id AS doc_id
         FROM block_refs r
         JOIN blocks t ON t.id = r.target_id AND t.is_deleted = 0 AND t.root_id IN (${ph})
         JOIN blocks s ON s.id = r.source_id AND s.is_deleted = 0
       )
       WHERE doc_id IS NOT NULL AND doc_id NOT IN (${excludePh})
       LIMIT ?`,
    )
    .all(...(args as [string | number, ...(string | number)[]])) as Array<{ doc_id: string }>
  return rows.map((r) => r.doc_id)
}

/** 选中集合内部的文档关联边：共享实体数 + block_refs 数，按权重倒序截断 */
function docEdges(db: Db, docIds: string[], maxEdges: number): GraphEdge[] {
  if (docIds.length < 2) return []
  const ph = docIds.map(() => '?').join(',')
  const rows = db
    .query(
      `WITH ed AS (
         SELECT DISTINCT m.entity_id AS e, b.root_id AS d
         FROM entity_mentions m
         JOIN blocks b ON b.id = m.block_id AND b.is_deleted = 0
         WHERE b.root_id IN (${ph})
       ),
       shared AS (
         SELECT a.d AS da, b.d AS db, COUNT(DISTINCT a.e) AS w
         FROM ed a JOIN ed b ON a.e = b.e AND a.d < b.d
         GROUP BY da, db
       ),
       refs AS (
         SELECT CASE WHEN s.root_id < t.root_id THEN s.root_id ELSE t.root_id END AS da,
                CASE WHEN s.root_id < t.root_id THEN t.root_id ELSE s.root_id END AS db,
                COUNT(*) AS w
         FROM block_refs r
         JOIN blocks s ON s.id = r.source_id AND s.is_deleted = 0
         JOIN blocks t ON t.id = r.target_id AND t.is_deleted = 0
         WHERE s.root_id IN (${ph}) AND t.root_id IN (${ph}) AND s.root_id <> t.root_id
         GROUP BY da, db
       ),
       combined AS (
         SELECT da, db, w FROM shared
         UNION ALL
         SELECT da, db, w FROM refs
       )
       SELECT da AS source, db AS target, SUM(w) AS w
       FROM combined
       GROUP BY da, db
       ORDER BY w DESC
       LIMIT ?`,
    )
    .all(...(docIds as [string, ...string[]]), ...(docIds as [string, ...string[]]), ...(docIds as [string, ...string[]]), maxEdges) as Array<{
    source: string
    target: string
    w: number
  }>
  return rows.map((r) => ({ source: r.source, target: r.target, weight: r.w }))
}

/** 全库活文档 + 关联度（连接其它文档数）；孤立笔记按 updated_at 兜底。q 过滤标题子串 */
function overviewDocs(db: Db, maxNodes: number, q?: string): DocRow[] {
  const degreeRows = db
    .query(
      `WITH ed AS (
         SELECT DISTINCT m.entity_id AS e, b.root_id AS d
         FROM entity_mentions m
         JOIN blocks b ON b.id = m.block_id AND b.is_deleted = 0
       ),
       pairs AS (
         SELECT a.d AS da, b.d AS db FROM ed a JOIN ed b ON a.e = b.e AND a.d < b.d
         UNION
         SELECT s.root_id AS da, t.root_id AS db
         FROM block_refs r
         JOIN blocks s ON s.id = r.source_id AND s.is_deleted = 0
         JOIN blocks t ON t.id = r.target_id AND t.is_deleted = 0
         WHERE s.root_id <> t.root_id
       ),
       undirected AS (
         SELECT da AS doc_id, db AS other FROM pairs
         UNION ALL
         SELECT db AS doc_id, da AS other FROM pairs
       )
       SELECT doc_id, COUNT(DISTINCT other) AS degree
       FROM undirected GROUP BY doc_id`,
    )
    .all() as Array<{ doc_id: string; degree: number }>
  const degree = new Map(degreeRows.map((r) => [r.doc_id, r.degree]))
  const likeCond = q ? ` AND b.content LIKE ? ESCAPE '\\'` : ''
  const docs = db
    .query(
      `SELECT b.id, b.content AS title, b.updated_at,
              (SELECT COUNT(*) FROM blocks c WHERE c.root_id = b.id AND c.is_deleted = 0 AND c.type != 'document') AS blocks
       FROM blocks b
       WHERE b.type = 'document' AND b.is_deleted = 0${likeCond}`,
    )
    .all(...(q ? [`%${escapeLike(q)}%`] : [])) as DocRow[]
  docs.sort(
    (a, b) =>
      (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || b.updated_at.localeCompare(a.updated_at),
  )
  return docs.slice(0, maxNodes)
}

/** LIKE 字面量转义（与 lexicalSearch 同规则，配合 ESCAPE '\'） */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`)
}

function docRowsByIds(db: Db, ids: string[]): DocRow[] {
  if (ids.length === 0) return []
  const rows = db
    .query(
      `SELECT b.id, b.content AS title, b.updated_at,
              (SELECT COUNT(*) FROM blocks c WHERE c.root_id = b.id AND c.is_deleted = 0 AND c.type != 'document') AS blocks
       FROM blocks b
       WHERE b.id IN (${ids.map(() => '?').join(',')}) AND b.type = 'document' AND b.is_deleted = 0`,
    )
    .all(...(ids as [string, ...string[]])) as DocRow[]
  // WHERE id IN 按 rowid 返回，丢失排序；按传入 ids 顺序重排（总览按关联度的 top-N 截断依赖此序）
  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids.map((id) => byId.get(id)).filter((r): r is DocRow => Boolean(r))
}

function queryDocGraph(db: Db, opts: GraphQueryOptions): GraphQueryResult {
  const depth = Math.max(1, Math.min(GRAPH_LIMITS.depth, opts.depth ?? 2))
  const maxNodes = Math.max(2, Math.min(GRAPH_LIMITS.maxNodes, opts.maxNodes ?? 80))
  const maxEdges = Math.max(0, Math.min(GRAPH_LIMITS.maxEdges, opts.maxEdges ?? 200))

  const dist = new Map<string, number>()
  if (opts.center?.type === 'doc') dist.set(opts.center.id, 0)

  const center = opts.center ? resolveCenterLabel(db, opts.center) : null

  let docIds: string[]
  let truncated: boolean
  if (dist.size === 0) {
    const docs = overviewDocs(db, maxNodes, opts.q)
    docIds = docs.map((d) => d.id)
    truncated = docs.length >= maxNodes
  } else {
    let frontier = [...dist.keys()]
    let curDist = 0
    while (frontier.length > 0 && dist.size < maxNodes && curDist < depth) {
      curDist++
      const next = neighboringDocs(db, frontier, {
        exclude: new Set(dist.keys()),
        limit: maxNodes - dist.size,
      })
      const added: string[] = []
      for (const d of next) {
        if (dist.size >= maxNodes) break
        dist.set(d, curDist)
        added.push(d)
      }
      if (added.length === 0) break
      frontier = added
    }
    truncated = dist.size >= maxNodes
    docIds = [...dist.keys()]
  }

  const rows = docRowsByIds(db, docIds)
  const nodes: GraphNode[] = rows.map((r) => ({
    id: r.id,
    name: r.title,
    display: r.title,
    type: 'doc',
    kind: 'doc',
    mention_count: r.blocks,
    distance: dist.get(r.id) ?? 0,
  }))
  const edges = docEdges(db, docIds, maxEdges)
  return { nodes, edges, center, truncated }
}

// ───────────────────── 入口 ─────────────────────

export function queryGraph(db: Db, opts: GraphQueryOptions = {}): GraphQueryResult {
  if (opts.mode === 'docs') return queryDocGraph(db, opts)
  return queryEntityGraph(db, opts)
}
