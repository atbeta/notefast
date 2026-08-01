/**
 * 图谱（Graph）— 实体共现图 API 契约类型（GET /api/v1/graph）
 *
 * 实体为节点、共现为边（两个实体在同一篇文档中被提及，权重 = 共享文档数）。
 * center 为锚点（实体或文档），BFS 扩展邻居；无 center 为全库 top-N 总览。
 */

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

export type GraphCenter = { type: 'entity'; id: string } | { type: 'doc'; id: string }

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  center: GraphCenter | null
  /** 节点数达到预算被截断 */
  truncated: boolean
}

/** kind → 图节点颜色（CSS 变量 + rgb() 包装，跟随深浅主题） */
const KIND_VAR: Record<string, string> = {
  concept: 'var(--graph-concept)',
  person: 'var(--graph-person)',
  tool: 'var(--graph-tool)',
  doc: 'var(--graph-doc)',
}

export function graphKindColor(kind: string): string {
  return `rgb(${KIND_VAR[kind] ?? 'var(--graph-other)'})`
}
