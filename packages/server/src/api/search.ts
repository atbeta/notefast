import { Hono } from 'hono'
import { highlightSnippet, rowToBlock } from '@notefast/core'
import type { BlockRow, SearchResult } from '@notefast/core'
import { getDb } from '../db'
import { lexicalSearch } from '../lexicalSearch'
import { listBacklinks } from '../store/refs'
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

  // status=archived：只在归档文档（含其子块）内检索，供归档页搜索框使用。
  // 文档根行的 root_id 为空，用 COALESCE 回落到自身 id 命中同一集合。
  // 不传 status 时保持现状（人类 Web 搜索不滤 ai_exclude / 生命周期状态）。
  const archivedOnly = c.req.query('status') === 'archived'

  // 双路词法检索（FTS5 + LIKE）：无空格中文走 LIKE 子串召回，ASCII 沿用 FTS bm25。
  // 人类 Web 搜索不滤 ai_exclude（与 MCP/AI 通道刻意不同）
  const hits = lexicalSearch(q, {
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

  // 取完整 block 行组装 SearchResult（返回形状不变；rank 改用列表内相对分 rank_score）
  const ids = hits.map((h) => h.id)
  const rowById = new Map<string, BlockRow>()
  if (ids.length > 0) {
    const rows = db
      .query(`SELECT * FROM blocks WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...(ids as [string, ...string[]])) as BlockRow[]
    for (const r of rows) rowById.set(r.id, r)
  }
  const results: SearchResult[] = hits.flatMap((h) => {
    const row = rowById.get(h.id)
    if (!row) return []
    return [{
      block: rowToBlock(row),
      rank: h.rank_score,
      snippet: highlightSnippet(row.content, q),
    }]
  })

  return c.json(results)
})

search.get('/refs', (c) => {
  const db = getDb()
  const targetId = c.req.query('target_id') || ''

  if (!targetId) {
    return c.json({ error: 'bad_request', message: '缺少 target_id 参数' }, 400)
  }

  const refs = listBacklinks(db, targetId)

  // 过滤来源属于 ai_exclude 文档的反链
  const excluded = loadAiExcludedDocIds(refs.map((r) => r.source_root_id))
  return c.json(refs.filter((r) => !excluded.has(r.source_root_id)))
})

export default search
