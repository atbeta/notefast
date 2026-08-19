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
import type { TagInfo } from '@notefast/core'
import { getTagProvider } from '@notefast/core'
import { getDb } from '../db'
import { listDocTagCounts } from '../store/blocks'

const tags = new Hono()

/** GET /api/v1/tags —— 列 notebook 下所有 tag + count（默认仅正式笔记：不含收集箱与归档） */
tags.get('/', (c) => {
  const notebookId = c.req.query('notebook_id') || ''
  const includeInbox = c.req.query('include_inbox') === '1' || c.req.query('include_inbox') === 'true'
  const providerName = getTagProvider().name
  const rows = listDocTagCounts(getDb(), {
    notebookId: notebookId || undefined,
    includeInbox,
  })
  const result: TagInfo[] = rows.map(({ tag, count }) => ({ tag, count }))
  return c.json({ provider: providerName, tags: result })
})

export default tags
