/**
 * AutoLink API（v4 —— 高置信直接建链，无人工审核）
 *
 * - POST   /api/v1/auto-link/run         body: { block_id }
 *   手动触发单个 block 的分析（满足阈值即直接写 block_refs，ref_type='ai_auto'）
 * - POST   /api/v1/auto-link/run-batch   body: { doc_id, max_blocks? }
 *   为某个 doc 下所有非 doc block 跑一次分析（兜底场景）
 * - DELETE /api/v1/auto-link/refs?source_id&target_id
 *   解除某对 block 之间的引用（用户想 undo）
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getDb } from '../db'
import { getBlockById, fetchDocBlocks } from '../store/blocks'
import { deleteRefByPair } from '../store/refs'
import { analyzeBlock } from '../ai/autoLink'
import { getRuntime, hasRuntime } from '../services/aiRuntime'

const autoLink = new Hono()

const FIX_HINT = '请在 Web UI /settings 页面配置 AI Provider，并启用 AutoLink'

const runSchema = z.object({
  block_id: z.string().min(1),
})

autoLink.post('/run', zValidator('json', runSchema), async (c) => {
  if (!hasRuntime() || !getRuntime().hasChat()) {
    return c.json({ error: 'not_configured', message: 'AI chat 未配置', fix_hint: FIX_HINT }, 400)
  }
  const { block_id } = c.req.valid('json')
  const db = getDb()
  const row = getBlockById(db, block_id)
  if (!row) return c.json({ error: 'not_found', message: `Block ${block_id} 不存在` }, 404)
  const cfg = getRuntime().autoLinkConfig()
  const result = await analyzeBlock({
    blockId: row.id,
    content: row.content || '',
    maxPerBlock: cfg.maxPerBlock,
  })
  return c.json({
    analyzed: result.analyzed,
    applied: result.applied,
    links: result.links,
    entities: result.entities,
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
  // 仅未删除的非文档根 block（文档量小，内存截断即可，不值得 SQL LIMIT）
  const rows = fetchDocBlocks(db, doc_id)
    .filter((r) => r.type !== 'document')
    .slice(0, max_blocks)
  const cfg = getRuntime().autoLinkConfig()
  let total = 0
  let applied = 0
  let entities = 0
  let errors = 0
  for (const row of rows) {
    try {
      const r = await analyzeBlock({
        blockId: row.id,
        content: row.content || '',
        maxPerBlock: cfg.maxPerBlock,
      })
      total++
      applied += r.applied
      entities += r.entities
      errors += r.errors.length
    } catch {
      errors++
    }
  }
  return c.json({ processed: total, applied, entities, errors })
})

/** 解除某对 block 之间的引用（用户想 undo） */
autoLink.delete('/refs', (c) => {
  const sourceId = c.req.query('source_id') || ''
  const targetId = c.req.query('target_id') || ''
  if (!sourceId || !targetId) {
    return c.json({ error: 'bad_request', message: '需要 source_id 和 target_id' }, 400)
  }
  const changed = deleteRefByPair(getDb(), sourceId, targetId)
  return c.json({ deleted: changed })
})

export default autoLink
