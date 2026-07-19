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
  sort: number
  level: number
  created_at: string
  updated_at: string
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
})

export const importMarkdownSchema = z.object({
  notebook_id: z.string().min(1).max(200),
  markdown: z.string().min(1).max(5_000_000),
  title: z.string().max(500).optional(),
})

export const updateDocMarkdownSchema = z.object({
  markdown: z.string().min(1).max(5_000_000),
  title: z.string().min(1).max(500).optional(),
})
