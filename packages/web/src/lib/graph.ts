/**
 * 图谱（Graph）— API 契约类型（GET /api/v1/graph）
 *
 * 两种模式：
 * - entities：实体为节点、共现为边（共享文档数）。节点 kind = 概念/人物/工具/文档。
 * - docs：笔记为节点、关联为边（共享实体数 + 引用数）。节点 type='doc'。
 * center 为锚点（实体或文档），BFS 扩展邻居；无 center 为全库 top-N 总览。
 */

export type GraphMode = 'entities' | 'docs'

export interface GraphNode {
  id: string
  name: string
  display: string
  /** entity = 实体（kind 着色）；doc = 笔记节点（方角样式） */
  type: 'entity' | 'doc'
  kind: string
  /** entities 模式 = 提及次数；docs 模式 = 活块数（节点大小代理） */
  mention_count: number
  /** 实体一句话描述（E2，可能为 null） */
  description?: string | null
  /** 距锚点集合的跳数；无中心（总览）时恒为 0 */
  distance: number
}

export interface GraphEdge {
  source: string
  target: string
  /** entities：共享文档数；docs：共享实体 + 引用数 */
  weight: number
}

export type GraphCenter =
  | { type: 'entity'; id: string; label?: string }
  | { type: 'doc'; id: string; label?: string }

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  center: GraphCenter | null
  /** 节点数达到预算被截断 */
  truncated: boolean
}

/** 实体 kind → 图节点颜色（CSS 变量 + rgb() 包装，跟随深浅主题） */
const KIND_VAR: Record<string, string> = {
  concept: 'var(--graph-concept)',
  person: 'var(--graph-person)',
  tool: 'var(--graph-tool)',
  doc: 'var(--graph-doc)',
}

export function graphKindColor(kind: string): string {
  return `rgb(${KIND_VAR[kind] ?? 'var(--graph-other)'})`
}

/** 笔记节点标识色（强调竖条 / 列表 swatch；节点本体为卡片样式，见 EntityGraph） */
export const GRAPH_NOTE_COLOR = 'rgb(var(--primary))'
