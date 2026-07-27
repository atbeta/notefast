/**
 * MCP 工具 —— AutoLink 组
 *
 * notefast_autolink_suggestions / apply / dismiss / revert / run /
 * get_autolink_suggestion。
 * get_autolink_suggestion 原先用旧 server.tool() API 注册，拆分时统一为
 * registerTool 风格（schema 与描述保持不变）。
 */

import { z } from 'zod'
import { getDb } from '../../db'
import { getBlockById } from '../../store/blocks'
import { hasRuntime, getRuntime } from '../../services/aiRuntime'
import {
  applySuggestion,
  dismissSuggestion,
  enrichSuggestions,
  findSuggestion,
  listSuggestions,
  revertSuggestion,
} from '../../ai/autoLinkStore'
import { analyzeBlock } from '../../ai/autoLink'
import {
  isDocAiExcluded,
  loadAiExcludedDocIds,
} from '../../ai/aiExcludeQuery'
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
    'notefast_autolink_suggestions',
    {
      description: 'AutoLink 链接建议视图。status=unreviewed 仅待处理建议；accepted=已接受（含自动应用）；dismissed=已忽略；all=全部。',
      inputSchema: {
        doc_id: z.string().optional().describe('限定文档 ID（不传则全局）'),
        status: z.enum(['unreviewed', 'accepted', 'dismissed', 'all']).optional().default('unreviewed'),
        limit: z.number().int().min(1).max(500).optional().default(100),
      },
    },
    async ({ doc_id, status, limit }) => {
      const reviewStatus = status === 'all' ? undefined : (status as 'unreviewed' | 'accepted' | 'dismissed')
      const list = listSuggestions({
        docId: doc_id,
        reviewStatus,
        limit,
        actionStatus: ['suggested', 'applied', 'reverted'],
      })
      const db = getDb()
      const items = enrichSuggestions(db, list).map(({ wire, source }) => ({
        ...wire,
        source_content: source.content,
        source_doc_id: source.docId,
        source_doc_title: source.docTitle,
      }))
      // 过滤来源属于 ai_exclude 文档的建议
      const excluded = loadAiExcludedDocIds(items.map((it) => it.source_doc_id ?? ''))
      const visible = items.filter((it) => !(it.source_doc_id && excluded.has(it.source_doc_id)))
      return { content: [toText({ status: status ?? 'unreviewed', count: visible.length, items: visible })] }
    },
  )

  registerTool(
    'notefast_autolink_apply',
    {
      description: '接受一条 AutoLink 建议，事务化写入 block_refs（ref_type=ai_suggested）；幂等。',
      inputSchema: {
        suggestion_id: z.string().describe('建议 ID'),
        candidate_index: z.number().int().min(0).max(4).optional().default(0),
      },
    },
    async ({ suggestion_id, candidate_index }) => {
      const result = applySuggestion(suggestion_id, candidate_index, 'ai_suggested')
      if (!result.applied && result.reason === 'not_found') {
        return toolError('not_found', `建议 ${suggestion_id} 不存在`, { suggestion_id })
      }
      return {
        content: [toText({
          applied: result.applied,
          ref_id: result.refId,
          target_id: result.targetBlockId,
          reason: result.reason,
        })],
      }
    },
  )

  registerTool(
    'notefast_autolink_dismiss',
    {
      description: '用户忽略一条 AutoLink 建议（review_status=dismissed，记录保留）',
      inputSchema: {
        suggestion_id: z.string().describe('建议 ID'),
      },
    },
    async ({ suggestion_id }) => {
      const result = dismissSuggestion(suggestion_id)
      if (!result.dismissed && result.reason === 'not_found') {
        return toolError('not_found', `建议 ${suggestion_id} 不存在`, { suggestion_id })
      }
      return { content: [toText({ dismissed: result.dismissed, reason: result.reason })] }
    },
  )

  registerTool(
    'notefast_autolink_revert',
    {
      description: '精确撤销一条已应用的 AutoLink 建议（按 created_ref_id 删除，可再次接受）',
      inputSchema: {
        suggestion_id: z.string().describe('建议 ID'),
      },
    },
    async ({ suggestion_id }) => {
      const result = revertSuggestion(suggestion_id)
      if (!result.reverted && result.reason === 'not_found') {
        return toolError('not_found', `建议 ${suggestion_id} 不存在`, { suggestion_id })
      }
      return { content: [toText({ reverted: result.reverted, reason: result.reason })] }
    },
  )

  registerTool(
    'notefast_autolink_run',
    {
      description: '对单个 block 立即触发 AutoLink 分析（AI 抽取实体 + 命中候选）',
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
        notebookId: row.notebook_id,
        notebookScope: cfg.notebookScope,
        maxPerBlock: cfg.maxPerBlock,
      })
      return {
        content: [toText({
          analyzed: r.analyzed,
          suggestions_added: r.suggestionsAdded,
          applied: r.applied,
          errors: r.errors,
          rate_limited: r.rateLimited === true,
          skipped_low_confidence: r.skippedLowConfidence ?? 0,
          skipped_anchors: r.skippedAnchors ?? [],
        })],
      }
    },
  )

  // ───────────────────── notefast_get_autolink_suggestion ─────────────────────
  registerTool(
    'notefast_get_autolink_suggestion',
    {
      description:
        '查看一条 AutoLink 建议的完整详情（包含来源文本、候选链接、置信度等），之后可决定 apply 或 dismiss。',
      inputSchema: {
        suggestion_id: z.string().min(1).max(64).describe('suggestion ID'),
      },
    },
    async ({ suggestion_id }) => {
      const db = getDb()
      // autolink_suggestions 表无 source_content / source_doc_title，需 join blocks 补全（与 list 接口一致）
      const s = findSuggestion(suggestion_id)
      if (!s) return toolError('not_found', `建议 ${suggestion_id} 不存在`, { suggestion_id })
      const enriched = enrichSuggestions(db, [s])[0]!
      // 拒绝来源属于 ai_exclude 文档的建议
      if (enriched.source.docId && isDocAiExcluded(enriched.source.docId)) {
        return toolError('forbidden', `该建议所属文档已对 AI 隐藏`, { suggestion_id })
      }
      const top = s.candidates[0] as { confidence?: number } | undefined
      return {
        content: [toText({
          id: s.id,
          source_block_id: s.sourceBlockId,
          source_content: (enriched.source.rawContent ?? '').slice(0, 2_000),
          source_doc_id: enriched.source.docId,
          source_doc_title: enriched.source.rawDocTitle ?? '',
          anchor: s.anchor,
          kind: s.kind,
          confidence: top?.confidence ?? null,
          score_kind: s.scoreKind,
          action_status: s.actionStatus,
          review_status: s.reviewStatus,
          candidates: s.candidates.slice(0, 10),
          error: s.error,
        })],
      }
    },
  )
}
