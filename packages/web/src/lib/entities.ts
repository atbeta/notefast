/**
 * 实体（Entity）— web 侧 API 契约类型与展示映射
 *
 * 写入时 AI 自动抽取的实体（概念/人物/工具/文档），后端登记 entities + entity_mentions。
 * 类型仅按 API 契约定义在 web 侧，不依赖 core 新类型。
 */

export interface EntitySummary {
  id: string
  name: string
  display: string
  kind: string
  mention_count: number
  /** 一句话描述（后台 LLM 生成；null = 未生成） */
  description?: string | null
}

/** 文档级实体（GET /docs/:id/entities），比 EntitySummary 少 name、多 surface */
export interface DocEntity {
  id: string
  display: string
  kind: string
  mention_count: number
  surface: string
}

export type EntityDocStatus = 'note' | 'inbox' | 'archived'

export interface EntityMention {
  block_id: string
  doc_id: string
  doc_title: string
  doc_status: EntityDocStatus
  surface: string
  block_snippet: string
}

export interface EntityDetail {
  entity: EntitySummary
  mentions: EntityMention[]
}

/** kind → 中文标签；未知 kind 原样展示 */
export const ENTITY_KIND_LABEL: Record<string, string> = {
  concept: '概念',
  person: '人物',
  tool: '工具',
  doc: '文档',
}

export function entityKindLabel(kind: string): string {
  return ENTITY_KIND_LABEL[kind] ?? kind
}

/** 提及所在文档状态标签（note 为常态不展示） */
export const ENTITY_DOC_STATUS_LABEL: Record<EntityDocStatus, string> = {
  note: '笔记',
  inbox: '收集箱',
  archived: '归档',
}
