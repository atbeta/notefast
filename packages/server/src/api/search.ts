import { Hono } from 'hono'
import { buildFtsQuery, highlightSnippet, rowToBlock } from '@notefast/core'
import type { BlockRow, SearchResult } from '@notefast/core'
import { getDb } from '../db'

const search = new Hono()

search.get('/', (c) => {
  const db = getDb()
  const q = c.req.query('q') || ''
  const notebookId = c.req.query('notebook_id') || ''
  const limit = parseInt(c.req.query('limit') || '20', 10)

  if (!q.trim()) {
    return c.json([])
  }

  const { query } = buildFtsQuery(q, limit)

  let sql = `
    SELECT b.*, rank FROM blocks_fts f
    JOIN blocks b ON b.id = f.id
    WHERE blocks_fts MATCH ?`
  const params: (string | number)[] = [query]

  if (notebookId) {
    sql += ' AND b.notebook_id = ?'
    params.push(notebookId)
  }

  sql += ' ORDER BY rank LIMIT ?'
  params.push(limit)

  const rows = db.query(sql).all(...params as [string, ...(string | number)[]]) as (BlockRow & { rank: number })[]
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
      `SELECT r.*, b.content as source_content, b.type as source_type
       FROM block_refs r
       JOIN blocks b ON b.id = r.source_id
       WHERE r.target_id = ?
       ORDER BY r.created_at DESC`,
    )
    .all(targetId) as (BlockRow & { source_content: string; source_type: string })[]

  return c.json(refs)
})

export default search
