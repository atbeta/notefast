import { Hono } from 'hono'
import { buildFtsQuery, highlightSnippet, rowToBlock } from '@notefast/core'
import type { BlockRow, SearchResult } from '@notefast/core'
import { getDb } from '../db'
import { runFtsQuery } from '../dbQueries'
import { loadAiExcludedDocIds } from '../ai/aiExcludeQuery'

const search = new Hono()

search.get('/', (c) => {
  const db = getDb()
  const q = c.req.query('q') || ''
  const notebookId = c.req.query('notebook_id') || ''
  const limitRaw = parseInt(c.req.query('limit') || '20', 10)
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 20

  if (!q.trim()) {
    return c.json([])
  }

  const { query } = buildFtsQuery(q, limit)

  // status=archived：只在归档文档（含其子块）内检索，供归档页搜索框使用。
  // 文档根行的 root_id 为空，用 COALESCE 回落到自身 id 命中同一集合。
  // 不传 status 时保持现状（人类 Web FTS 不滤 ai_exclude / 生命周期状态）。
  const archivedOnly = c.req.query('status') === 'archived'

  // 人类 Web FTS 搜索不滤 ai_exclude（与 MCP/AI 通道刻意不同）
  const rows = runFtsQuery(db, {
    match: query,
    notebookId: notebookId || undefined,
    limit,
    ...(archivedOnly
      ? {
          extraWhere: [
            "AND COALESCE(NULLIF(b.root_id, ''), b.id) IN (SELECT id FROM blocks WHERE type = 'document' AND status = 'archived')",
          ],
        }
      : {}),
  })
  const results: SearchResult[] = rows.map((r) => {
    const block = rowToBlock(r)
    return {
      block,
      rank: r.rank,
      snippet: highlightSnippet(block.content, q),
    }
  })

  return c.json(results)
})

search.get('/refs', (c) => {
  const db = getDb()
  const targetId = c.req.query('target_id') || ''

  if (!targetId) {
    return c.json({ error: 'bad_request', message: '缺少 target_id 参数' }, 400)
  }

  const refs = db
    .query(
      `SELECT r.*, b.content as source_content, b.type as source_type, b.root_id as source_root_id
       FROM block_refs r
       JOIN blocks b ON b.id = r.source_id
       WHERE r.target_id = ?
       ORDER BY r.created_at DESC`,
    )
    .all(targetId) as (BlockRow & { source_content: string; source_type: string; source_root_id: string })[]

  // 过滤来源属于 ai_exclude 文档的反链
  const excluded = loadAiExcludedDocIds(refs.map((r) => r.source_root_id))
  return c.json(refs.filter((r) => !excluded.has(r.source_root_id)))
})

export default search
