/**
 * MCP 工具 —— 实体（图谱）只读组
 *
 * - notefast_search_entities(query, limit)  搜索实体（概念/人物/工具/文档），
 *   返回提及次数与一句话描述
 * - notefast_get_entity_notes(entity_id)    获取提及某实体的笔记列表
 *
 * 走与 REST 相同的读路径。ai_exclude 实体已物理 purge 天然安全；
 * 笔记按 MCP 默认过滤语义（status=note 排除收集箱/归档，可显式覆盖）。
 */

import { z } from 'zod'
import { getDb } from '../../db'
import {
  getEntityById,
  listEntities,
  listEntityMentions,
} from '../../store/entities'
import { toText, toolError, type ToolContext } from './helpers'

const SNIPPET_LEN = 200

export function registerEntityTools(ctx: ToolContext): void {
  const { registerTool } = ctx

  registerTool(
    'notefast_search_entities',
    {
      description: '搜索实体（概念/人物/工具/文档），返回提及次数与一句话描述。实体是知识库自动维护的主题索引',
      inputSchema: {
        query: z.string().min(1).max(200).describe('实体名关键词'),
        limit: z.number().int().min(1).max(100).optional().default(20).describe('最大返回数量'),
      },
    },
    async ({ query, limit }) => {
      const rows = listEntities(getDb(), { q: query, limit: limit as number })
      return {
        content: [
          toText({
            entities: rows.map((e) => ({
              id: e.id,
              name: e.name,
              display: e.display,
              kind: e.kind,
              mention_count: e.mention_count,
              description: e.description ?? null,
            })),
          }),
        ],
      }
    },
  )

  registerTool(
    'notefast_get_entity_notes',
    {
      description: '获取提及某实体的笔记列表（按文档去重，含引用片段）。实体 ID 来自 notefast_search_entities',
      inputSchema: {
        entity_id: z.string().min(1).describe('实体 ID'),
        status: z
          .enum(['note', 'inbox', 'archived', 'all'])
          .optional()
          .default('note')
          .describe('笔记状态过滤；默认 note 排除收集箱与归档，all 为全部'),
        limit: z.number().int().min(1).max(100).optional().default(20).describe('最大返回数量'),
      },
    },
    async ({ entity_id, status, limit }) => {
      const db = getDb()
      const entity = getEntityById(db, entity_id)
      if (!entity) {
        return toolError('not_found', `实体 ${entity_id} 不存在`, { entity_id })
      }
      const mentions = listEntityMentions(db, entity_id)
        .filter((m) => (status === 'all' ? true : m.doc_status === status))
        .slice(0, limit as number)
      return {
        content: [
          toText({
            entity: {
              id: entity.id,
              display: entity.display,
              kind: entity.kind,
              mention_count: entity.mention_count,
              description: entity.description ?? null,
            },
            notes: mentions.map((m) => ({
              doc_id: m.doc_id,
              doc_title: m.doc_title,
              doc_status: m.doc_status,
              block_id: m.block_id,
              surface: m.surface,
              snippet: (m.block_content ?? '').slice(0, SNIPPET_LEN),
            })),
          }),
        ],
      }
    },
  )
}
