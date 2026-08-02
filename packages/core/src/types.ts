import { z } from 'zod'

/** Block 类型常量 */
export const BlockType = {
  Document: 'document',
  Heading: 'heading',
  Paragraph: 'paragraph',
  List: 'list',
  ListItem: 'list_item',
  Code: 'code',
  Quote: 'quote',
  Table: 'table',
} as const

export type BlockType = (typeof BlockType)[keyof typeof BlockType]

/** Block */
export interface Block {
  id: string
  notebook_id: string
  parent_id: string | null
  root_id: string
  type: BlockType
  content: string
  properties: Record<string, unknown>
  tags: string[]
  status: 'note' | 'inbox' | 'archived'
  ai_exclude: boolean
  sort: number
  level: number
  created_at: string
  updated_at: string
  children: Block[]
}

/** Block 属性（数据库存储格式） */
export interface BlockRow {
  id: string
  notebook_id: string
  parent_id: string | null
  root_id: string
  type: string
  content: string
  properties: string
  tags: string
  status: string
  ai_exclude: number
  sort: number
  level: number
  created_at: string
  updated_at: string
}

/** Block 内容历史 revision（block_revisions 表） */
export interface BlockRevision {
  block_id: string
  rev: number
  content: string
  content_hash: string
  actor: string
  created_at: string
}

/** 整篇文档快照（doc_snapshots 表）：编辑器整篇保存前的全文快照 */
export interface DocSnapshot {
  doc_id: string
  rev: number
  content: string
  content_hash: string
  actor: string
  created_at: string
}

/** 文档历史面板条目：块级修订与整篇快照的合并视图（kind 区分来源） */
export interface DocRevisionEntry {
  kind: 'block' | 'snapshot'
  block_id: string
  rev: number
  content: string
  actor: string
  created_at: string
  /**
   * 合成条目：当前文档最新状态（非真实存储的修订）。
   * 仅用于展示「当前 vs 上一次保存」的 diff，不参与回退。
   */
  is_current?: boolean
}

/** 创建 Block 的输入 */
export interface CreateBlockInput {
  id?: string
  notebook_id: string
  parent_id?: string | null
  type: BlockType
  content?: string
  properties?: Record<string, unknown>
  sort?: number
}

/** 更新 Block 的输入 */
export interface UpdateBlockInput {
  content?: string
  properties?: Record<string, unknown>
  type?: BlockType
}

/** 移动 Block 的输入 */
export interface MoveBlockInput {
  new_parent_id: string | null
  new_sort?: number
}

/** Notebook */
export interface Notebook {
  id: string
  name: string
  icon: string
  sort: number
  created_at: string
  updated_at: string
}

/** Document 摘要（用于列表） */
export interface DocSummary {
  id: string
  title: string
  created_at: string
  updated_at: string
  /** 文档级 tags（已 normalize） */
  tags: string[]
  /** 对 AI 隐藏：不进向量 / RAG / AutoLink / MCP */
  ai_exclude?: boolean
  /** 生命周期：inbox=收集箱，archived=归档；缺省视为 note */
  status?: 'note' | 'inbox' | 'archived'
}

/** 搜索结果 */
export interface SearchResult {
  block: Block
  rank: number
  snippet: string
}

/** 引用关系 */
export interface BlockRef {
  id: number
  source_id: string
  target_id: string
  ref_type: string
  created_at: string
}

/** API 错误响应 */
export interface ApiError {
  error: string
  message: string
  details?: unknown
}

/** Heading 树节点 */
export interface HeadingNode {
  id: string
  content: string
  level: number
  children: HeadingNode[]
}

// ───────────────────── API 线格式（server ↔ web 共享，字段以 server 实际返回为准） ─────────────────────

/** /ai/diagnose 单项能力探测结果（公共字段） */
export interface AiDiagnoseProbe {
  configured: boolean
  ok: boolean
  latencyMs?: number
  model?: string
  error?: string
  message?: string
}

/** /ai/diagnose — embedding 探测 */
export interface AiDiagnoseEmbedding extends AiDiagnoseProbe {
  dim?: number
  embeddingCalls?: number
}

/** /ai/diagnose — chat 探测 */
export interface AiDiagnoseChat extends AiDiagnoseProbe {
  replySample?: string
}

/** /ai/diagnose — reranker 探测 */
export interface AiDiagnoseReranker extends AiDiagnoseProbe {
  hitCount?: number
}

/** /ai/diagnose 响应（autoLink 仅在 runtime 已初始化时返回） */
export interface AiDiagnoseResult {
  overall: 'healthy' | 'partial' | 'degraded' | 'idle' | 'not_configured'
  embedding: AiDiagnoseEmbedding
  chat: AiDiagnoseChat
  reranker: AiDiagnoseReranker
  autoLink?: {
    configured: boolean
    enabled: boolean
    ok: boolean
    prerequisites: {
      chat: { configured: boolean; ok: boolean }
      /** embedding 非强依赖：已配置时为 ok 布尔值，未配置为 null */
      embedding: boolean | null
    }
  }
  elapsedMs: number
  ts: string
}

/** API 请求校验 schema */
export const createBlockSchema = z.object({
  notebook_id: z.string().min(1).max(200),
  parent_id: z.string().max(200).optional().nullable(),
  type: z.enum([
    BlockType.Document,
    BlockType.Heading,
    BlockType.Paragraph,
    BlockType.List,
    BlockType.ListItem,
    BlockType.Code,
    BlockType.Quote,
    BlockType.Table,
  ]),
  content: z.string().max(500_000).optional().default(''),
  properties: z.record(z.unknown()).optional().default({}),
  sort: z.number().int().optional().default(0),
})

export const updateBlockSchema = z.object({
  content: z.string().max(500_000).optional(),
  properties: z.record(z.unknown()).optional(),
  type: z
    .enum([
      BlockType.Document,
      BlockType.Heading,
      BlockType.Paragraph,
      BlockType.List,
      BlockType.ListItem,
      BlockType.Code,
      BlockType.Quote,
      BlockType.Table,
    ])
    .optional(),
})

export const moveBlockSchema = z.object({
  new_parent_id: z.string().nullable(),
  new_sort: z.number().int().optional(),
})

export const createDocSchema = z.object({
  notebook_id: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  /** inbox=收集箱；缺省为正式笔记 */
  status: z.enum(['note', 'inbox']).optional(),
  /** 可选正文（Markdown）；常用于快速采集到收集箱 */
  markdown: z.string().max(5_000_000).optional(),
  /** 初始标签 */
  tags: z.array(z.string().min(1).max(64)).max(64).optional(),
})

export const importMarkdownSchema = z.object({
  notebook_id: z.string().min(1).max(200),
  markdown: z.string().min(1).max(5_000_000),
  title: z.string().max(500).optional(),
  status: z.enum(['note', 'inbox']).optional(),
  tags: z.array(z.string().min(1).max(64)).max(64).optional(),
})

export const updateDocStatusSchema = z.object({
  status: z.enum(['note', 'inbox', 'archived']),
})

export const updateDocMarkdownSchema = z.object({
  markdown: z.string().min(1).max(5_000_000),
  title: z.string().min(1).max(500).optional(),
})
