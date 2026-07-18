/**
 * AutoLink API
 *
 * - GET    /api/v1/auto-link/suggestions?doc_id=X
 *   列出某 doc 下所有 block 的 pending 建议
 * - POST   /api/v1/auto-link/apply       body: { suggestion_id, candidate_index? }
 *   把建议落入 block_refs
 * - POST   /api/v1/auto-link/dismiss     body: { suggestion_id }
 *   丢弃建议
 * - POST   /api/v1/auto-link/run         body: { block_id }
 *   手动触发单个 block 的分析
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getDb } from '../db'
import {
  analyzeBlock,
  insertRef,
  deleteRefByPair,
  listBlockIdsForDoc,
} from '../ai/autoLink'
import {
  findSuggestion,
  listSuggestionsForBlock,
  listSuggestionsForDoc,
  removeSuggestionById,
  toWire,
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

const applySchema = z.object({
  suggestion_id: z.string().min(1),
  candidate_index: z.number().int().min(0).max(4).optional().default(0),
})

autoLink.post('/apply', zValidator('json', applySchema), (c) => {
  const { suggestion_id, candidate_index } = c.req.valid('json')
  const s = findSuggestion(suggestion_id)
  if (!s) return c.json({ error: 'not_found', message: '建议不存在或已过期' }, 404)
  const candidate = s.candidates[candidate_index]
  if (!candidate) return c.json({ error: 'bad_request', message: '无效的 candidate_index' }, 400)
  const created = insertRef(s.sourceBlockId, candidate.blockId, 'ai_link')
  removeSuggestionById(suggestion_id)
  return c.json({ applied: created, source_id: s.sourceBlockId, target_id: candidate.blockId })
})

const dismissSchema = z.object({ suggestion_id: z.string().min(1) })

autoLink.post('/dismiss', zValidator('json', dismissSchema), (c) => {
  const { suggestion_id } = c.req.valid('json')
  const removed = removeSuggestionById(suggestion_id)
  return c.json({ dismissed: removed })
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

/** 列出某 block 上的 pending 建议（doc 列表视图的二级 fallback） */
autoLink.get('/block/:blockId', (c) => {
  const blockId = c.req.param('blockId')
  const list = listSuggestionsForBlock(blockId)
  return c.json({ block_id: blockId, suggestions: list.map(toWire) })
})

export default autoLink
