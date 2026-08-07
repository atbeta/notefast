/**
 * 实体（Entity）— web 侧 API 契约类型与展示映射
 *
 * 写入时 AI 自动抽取的实体（概念/人物/工具/文档），后端登记 entities + entity_mentions。
 * 类型仅按 API 契约定义在 web 侧，不依赖 core 新类型。
 */

import i18next from '../i18n'

export interface EntitySummary {
  id: string
  name: string
  display: string
  kind: string
  mention_count: number
  /** 有效描述：词典（用户声明）优先于 AI 生成；null = 未生成 */
  description?: string | null
  /** 描述来源（dict = 词典声明，ai = AI 生成） */
  description_source?: 'dict' | 'ai' | null
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

/** kind → 本地化标签；未知 kind 原样展示 */
export function entityKindLabel(kind: string): string {
  switch (kind) {
    case 'concept': return i18next.t('entities.kindConcept')
    case 'person': return i18next.t('entities.kindPerson')
    case 'tool': return i18next.t('entities.kindTool')
    case 'doc': return i18next.t('entities.kindDoc')
    default: return kind
  }
}

/** 提及所在文档状态标签（note 为常态不展示） */
export function entityDocStatusLabel(status: EntityDocStatus): string {
  switch (status) {
    case 'note': return i18next.t('entities.docStatusNote')
    case 'inbox': return i18next.t('entities.docStatusInbox')
    case 'archived': return i18next.t('entities.docStatusArchived')
  }
}
