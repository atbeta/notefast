/**
 * AutoLink API（v2）
 *
 * - GET    /api/v1/auto-link/suggestions?doc_id=X
 *   列出某 doc 下所有 block 的活跃建议（apply/revert 状态后保留 history）
 * - GET    /api/v1/auto-link/inbox?status=&limit=
 *   跨 doc 全局 Inbox；默认 review_status=unreviewed
 * - POST   /api/v1/auto-link/apply       body: { suggestion_id, candidate_index? }
 *   事务化接受建议（写入 block_refs，created_ref_id 精确归属）
 * - POST   /api/v1/auto-link/dismiss     body: { suggestion_id }
 *   用户忽略（review_status=dismissed，保留记录）
 * - POST   /api/v1/auto-link/:id/revert
 *   精确撤销（按 created_ref_id 删除）
 * - POST   /api/v1/auto-link/run         body: { block_id }
 *   手动触发单个 block 的分析
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getDb } from '../db'
import {
  analyzeBlock,
  deleteRefByPair,
  listBlockIdsForDoc,
} from '../ai/autoLink'
import {
  applySuggestion,
  dismissSuggestion,
  listSuggestions,
  listSuggestionsForBlock,
  listSuggestionsForDoc,
  revertSuggestion,
  toWire,
  type ReviewStatus,
  type ActionStatus,
} from '../ai/autoLinkStore'
import { getRuntime, hasRuntime } from '../services/aiRuntime'

const autoLink = new Hono()

const FIX_HINT = '请在 Web UI /settings 页面配置 AI Provider，并启用 AutoLink'

autoLink.get('/suggestions', (c) => {
  const docId = c.req.query('doc_id') || ''
  if (!docId) return c.json({ error: 'bad_request', message: '缺少 doc_id' }, 400)
  const blockIds = listBlockIdsForDoc(docId)
  const suggestions = listSuggestionsForDoc(docId, blockIds)
  return c.json({
    doc_id: docId,
    count: suggestions.length,
    suggestions: suggestions.map(toWire),
  })
})

/**
 * 全局 Inbox（v2）
 * 默认 review_status=unreviewed，包含 AI 已执行 + AI 仅建议两类
 */
autoLink.get('/inbox', (c) => {
  const status = c.req.query('status') || 'unreviewed'
  const limit = Math.min(parseInt(c.req.query('limit') || '100', 10) || 100, 500)
  const reviewStatus = status === 'all' ? undefined : (status as ReviewStatus)

  const suggestions = listSuggestions({
    reviewStatus,
    limit,
    actionStatus: ['suggested', 'applied', 'reverted'] as ActionStatus[],
  })

  // 补 source content / doc title（Inbox UI 需要）
  const db = getDb()
  const items = suggestions.map((s) => {
    const wire = toWire(s)
    const srcRow = db
      .query(
        `SELECT b.content, b.root_id, (SELECT content FROM blocks WHERE id = b.root_id) as doc_title
         FROM blocks b WHERE b.id = ?`,
      )
      .get(s.sourceBlockId) as { content: string; root_id: string; doc_title: string } | undefined
    return {
      ...wire,
      source_content: srcRow?.content?.slice(0, 200) ?? '',
      source_doc_id: srcRow?.root_id ?? null,
      source_doc_title: srcRow?.doc_title ?? '未命名文档',
    }
  })

  return c.json({ status, count: items.length, items })
})

const applySchema = z.object({
  suggestion_id: z.string().min(1),
  candidate_index: z.number().int().min(0).max(4).optional().default(0),
})

autoLink.post('/apply', zValidator('json', applySchema), (c) => {
  const { suggestion_id, candidate_index } = c.req.valid('json')
  const result = applySuggestion(suggestion_id, candidate_index, 'ai_suggested')
  if (!result.applied && !result.refId) {
    return c.json(
      { error: 'apply_failed', reason: result.reason ?? 'unknown' },
      result.reason === 'not_found' ? 404 : 400,
    )
  }
  return c.json({
    applied: result.applied,
    ref_id: result.refId,
    source_id: undefined as string | undefined,
    target_id: result.targetBlockId,
    reason: result.reason,
  })
})

const dismissSchema = z.object({ suggestion_id: z.string().min(1) })

autoLink.post('/dismiss', zValidator('json', dismissSchema), (c) => {
  const { suggestion_id } = c.req.valid('json')
  const result = dismissSuggestion(suggestion_id)
  if (!result.dismissed && result.reason === 'not_found') {
    return c.json({ error: 'not_found' }, 404)
  }
  return c.json({ dismissed: result.dismissed, reason: result.reason })
})

/**
 * 批量审阅（v3）：对给定 id 列表统一接受 / 忽略
 * - accept：逐条 applySuggestion（写 block_refs），失败的计入 failed 不中断
 * - dismiss：逐条 dismissSuggestion
 * 前端确认弹窗由调用方负责；此接口只做幂等执行
 */
const bulkReviewSchema = z.object({
  action: z.enum(['accept', 'dismiss']),
  ids: z.array(z.string().min(1)).min(1).max(500),
})

autoLink.post('/bulk-review', zValidator('json', bulkReviewSchema), (c) => {
  const { action, ids } = c.req.valid('json')
  let done = 0
  let failed = 0
  for (const id of ids) {
    const r = action === 'accept'
      ? applySuggestion(id, 0, 'ai_suggested').applied
      : dismissSuggestion(id).dismissed
    if (r) done++
    else failed++
  }
  return c.json({ action, done, failed, total: ids.length })
})

/**
 * 精确撤销（v2）：按 created_ref_id 删除，不依赖 (source, target) 对
 */
autoLink.post('/:suggestion_id/revert', (c) => {
  const suggestionId = c.req.param('suggestion_id')
  const result = revertSuggestion(suggestionId)
  if (!result.reverted && result.reason === 'not_found') {
    return c.json({ error: 'not_found' }, 404)
  }
  return c.json({ reverted: result.reverted, reason: result.reason })
})

const runSchema = z.object({
  block_id: z.string().min(1),
})

autoLink.post('/run', zValidator('json', runSchema), async (c) => {
  if (!hasRuntime() || !getRuntime().hasChat()) {
    return c.json({ error: 'not_configured', message: 'AI chat 未配置', fix_hint: FIX_HINT }, 400)
  }
  const { block_id } = c.req.valid('json')
  const db = getDb()
  const row = db.query('SELECT id, content, notebook_id FROM blocks WHERE id = ?').get(block_id) as
    | { id: string; content: string; notebook_id: string }
    | undefined
  if (!row) return c.json({ error: 'not_found', message: `Block ${block_id} 不存在` }, 404)
  const cfg = getRuntime().autoLinkConfig()
  const result = await analyzeBlock({
    blockId: row.id,
    content: row.content || '',
    notebookId: row.notebook_id,
    notebookScope: cfg.notebookScope,
    maxPerBlock: cfg.maxPerBlock,
  })
  return c.json({
    analyzed: result.analyzed,
    suggestions_added: result.suggestionsAdded,
    applied: result.applied,
    errors: result.errors,
    rate_limited: result.rateLimited === true,
    skipped_low_confidence: result.skippedLowConfidence ?? 0,
    skipped_anchors: result.skippedAnchors ?? [],
  })
})

/** 给 doc 批量：手动为某个 doc 下所有非 doc block 跑一次分析（兜底场景） */
const runBatchSchema = z.object({
  doc_id: z.string().min(1),
  max_blocks: z.number().int().min(1).max(500).optional().default(50),
})

autoLink.post('/run-batch', zValidator('json', runBatchSchema), async (c) => {
  if (!hasRuntime() || !getRuntime().hasChat()) {
    return c.json({ error: 'not_configured', message: 'AI chat 未配置', fix_hint: FIX_HINT }, 400)
  }
  const { doc_id, max_blocks } = c.req.valid('json')
  const db = getDb()
  const rows = db
    .query('SELECT id, content, notebook_id FROM blocks WHERE root_id = ? AND type != ? LIMIT ?')
    .all(doc_id, 'document', max_blocks) as Array<{ id: string; content: string; notebook_id: string }>
  const cfg = getRuntime().autoLinkConfig()
  let total = 0
  let suggestions = 0
  let errors = 0
  for (const row of rows) {
    try {
      const r = await analyzeBlock({
        blockId: row.id,
        content: row.content || '',
        notebookId: row.notebook_id,
        notebookScope: cfg.notebookScope,
        maxPerBlock: cfg.maxPerBlock,
      })
      total++
      suggestions += r.suggestionsAdded
      errors += r.errors.length
    } catch {
      errors++
    }
  }
  return c.json({ processed: total, suggestions, errors })
})

/** 解除某 block 上的某条 ai_link 引用（用户想 undo） */
autoLink.delete('/refs', (c) => {
  const sourceId = c.req.query('source_id') || ''
  const targetId = c.req.query('target_id') || ''
  if (!sourceId || !targetId) {
    return c.json({ error: 'bad_request', message: '需要 source_id 和 target_id' }, 400)
  }
  const changed = deleteRefByPair(sourceId, targetId)
  return c.json({ deleted: changed })
})

/** 列出某 block 上的活跃建议 */
autoLink.get('/block/:blockId', (c) => {
  const blockId = c.req.param('blockId')
  const list = listSuggestionsForBlock(blockId)
  return c.json({ block_id: blockId, suggestions: list.map(toWire) })
})

export default autoLink
