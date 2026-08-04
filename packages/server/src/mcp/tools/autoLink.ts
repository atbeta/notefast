/**
 * MCP 工具 —— AutoLink 组
 *
 * 仅保留 notefast_autolink_run：AutoLink 已改为「AI 抽取 → 高置信直接建链」
 * 单态模型，无建议/审核队列，原 suggestions / apply / dismiss / revert /
 * get_autolink_suggestion 工具随三态模型一并移除。
 */

import { z } from 'zod'
import { getDb } from '../../db'
import { getBlockById } from '../../store/blocks'
import { hasRuntime, getRuntime } from '../../services/aiRuntime'
import { analyzeBlock } from '../../ai/autoLink'
import {
  NOT_CONFIGURED_HINT,
  denyAiExcludedBlock,
  toText,
  toolError,
  type ToolContext,
} from './helpers'

export function registerAutoLinkTools(ctx: ToolContext): void {
  const { registerTool } = ctx

  registerTool(
    'notefast_autolink_run',
    {
      description: '立即对单个 block 执行 AI 建链分析（抽取实体锚点 + 语义命中候选）；满足高置信阈值即直接建立引用（block_refs，ref_type=ai_auto），无需人工审核。',
      inputSchema: {
        block_id: z.string().describe('Block ID'),
      },
    },
    async ({ block_id }) => {
      if (!hasRuntime() || !getRuntime().hasChat()) {
        return toolError('not_configured', 'Chat 模型未配置', { fix_hint: NOT_CONFIGURED_HINT })
      }
      const denied = denyAiExcludedBlock(block_id)
      if (denied) return denied
      const db = getDb()
      const row = getBlockById(db, block_id)
      if (!row) {
        return toolError('not_found', `Block ${block_id} 不存在`, { block_id })
      }
      const cfg = getRuntime().autoLinkConfig()
      const r = await analyzeBlock({
        blockId: row.id,
        content: row.content || '',
        maxPerBlock: cfg.maxPerBlock,
      })
      return {
        content: [toText({
          analyzed: r.analyzed,
          applied: r.applied,
          links: r.links,
          errors: r.errors,
          rate_limited: r.rateLimited === true,
          skipped_low_confidence: r.skippedLowConfidence ?? 0,
          skipped_anchors: r.skippedAnchors ?? [],
        })],
      }
    },
  )
}
