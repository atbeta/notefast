/**
 * MCP 工具 —— 固定视图（侧栏「固定视图」）
 *
 * 与 REST /api/v1/pinned-views 同构：query 是首页 URL 搜索串（无前导 ?）。
 * 也可用 tags / untagged 等字段拼 query，避免模型手写错查询串。
 */

import { z } from 'zod'
import {
  createPinnedView,
  deletePinnedView,
  listPinnedViews,
  PinnedViewError,
} from '../../services/pinnedViews'
import { toText, toolError, type ToolContext } from './helpers'

export function registerPinnedViewTools(ctx: ToolContext): void {
  const { registerTool } = ctx

  registerTool(
    'notefast_list_pinned_views',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      description: '列出侧栏固定视图（名称 + 筛选 query）。新建前先看是否已有相同筛选。',
      inputSchema: {},
    },
    async () => {
      return { content: [toText({ views: listPinnedViews() })] }
    },
  )

  registerTool(
    'notefast_pin_view',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        '把一组筛选固定到侧栏「固定视图」。用户说「固定这个筛选」「加一个 work 标签的视图」时调用。不要发明用户没提过的筛选。query 与首页 URL 同构，如 tags=work、untagged=1、stale_within=90d；也可用 tags 等字段代替手写 query。',
      inputSchema: {
        name: z.string().min(1).max(50).describe('侧栏显示名，如「工作」或「01-工作」'),
        query: z.string().min(1).max(500).optional().describe('筛选串，如 tags=work&tag_match=any；与结构化字段二选一，query 优先'),
        tags: z.array(z.string().min(1)).optional().describe('按这些标签筛选（编译为 tags=a,b）'),
        tag_match: z.enum(['all', 'any']).optional().describe('多标签：all=同时包含（默认），any=包含任一'),
        untagged: z.boolean().optional().describe('仅未打标签的文档'),
        ai_exclude: z.boolean().optional().describe('仅对 AI 隐藏的文档'),
        status: z.enum(['inbox', 'archived', 'all']).optional().describe('文档状态筛选'),
        updated_within: z.enum(['24h', '7d', '30d']).optional(),
        created_within: z.enum(['24h', '7d', '30d']).optional(),
        stale_within: z.enum(['30d', '90d']).optional(),
      },
    },
    async (args) => {
      try {
        const { view, created } = createPinnedView(args)
        return { content: [toText({ ...view, created })] }
      } catch (e) {
        if (e instanceof PinnedViewError) {
          return toolError(e.code === 'limit' ? 'invalid_params' : e.code, e.message)
        }
        throw e
      }
    },
  )

  registerTool(
    'notefast_unpin_view',
    {
      annotations: { readOnlyHint: false, destructiveHint: true },
      description: '取消固定视图。id 来自 notefast_list_pinned_views。',
      inputSchema: {
        id: z.string().describe('固定视图 ID'),
      },
    },
    async ({ id }) => {
      const ok = deletePinnedView(id)
      if (!ok) return toolError('not_found', '固定视图不存在', { id })
      return { content: [toText({ deleted: true, id })] }
    },
  )
}
