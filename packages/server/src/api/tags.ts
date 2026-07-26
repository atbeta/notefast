/**
 * 标签 API
 *
 * 不绑死实现：当前用 PropertiesTagProvider（从 doc.properties.tags 读），
 * 未来可换任意实现，endpoint 形态不变。
 *
 * 路由：
 *   GET    /api/v1/tags                              → 所有 tag + count（默认不含收集箱）
 *   GET    /api/v1/tags?notebook_id=...              → 单 notebook
 *   GET    /api/v1/tags?include_inbox=1              → 计入收集箱文档的 tag
 *
 * tag 永远小写、限长 64、字母数字+连字符（具体规则见 core/tags.ts）。
 *
 * 注：PATCH /api/v1/docs/:id/tags 挂在 docs.ts（mount 在 /api/v1/docs），
 *    这样 URL 层级更清晰（tags 是 doc 的子资源）。
 */

import { Hono } from 'hono'
import {
  type BlockRow,
  type TagInfo,
  getTagProvider,
  readTags,
  readDocStatus,
  isDocArchived,
} from '@notefast/core'
import { getDb } from '../db'

const tags = new Hono()

/** GET /api/v1/tags —— 列 notebook 下所有 tag + count（默认仅正式笔记：不含收集箱与归档） */
tags.get('/', (c) => {
  const db = getDb()
  const notebookId = c.req.query('notebook_id') || ''
  const includeInbox = c.req.query('include_inbox') === '1' || c.req.query('include_inbox') === 'true'
  const providerName = getTagProvider().name

  let rows: BlockRow[]
  if (notebookId) {
    rows = db
      .query("SELECT * FROM blocks WHERE type = 'document' AND notebook_id = ? AND is_deleted = 0")
      .all(notebookId) as BlockRow[]
  } else {
    rows = db.query("SELECT * FROM blocks WHERE type = 'document' AND is_deleted = 0").all() as BlockRow[]
  }

  // 归档一律不进 tags 聚合；include_inbox=1 仅放开收集箱
  rows = rows.filter((r) => (includeInbox ? !isDocArchived(r) : readDocStatus(r) === 'note'))

  const counts = new Map<string, number>()
  for (const r of rows) {
    const ts = readTags(r)
    for (const t of ts) counts.set(t, (counts.get(t) ?? 0) + 1)
  }

  const result: TagInfo[] = Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag))

  return c.json({ provider: providerName, tags: result })
})

export default tags
