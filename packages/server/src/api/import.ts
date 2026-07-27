import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { importMarkdownSchema, rowToBlock } from '@notefast/core'
import { getDb } from '../db'
import { getBlockById, getBlocksByIds } from '../store/blocks'
import { fireAfterCreate, fireAfterCreateMany } from '../services/hooks'
import { extractAssetRefs, findMissingAssets } from '../assets/store'
import { EmptyMarkdownError, insertDocFromMarkdown, type InsertDocFromMarkdownResult } from '../services/docImport'
import { scheduleDocIndex } from '../ai/indexJobs'

const importRouter = new Hono()

importRouter.post('/markdown', zValidator('json', importMarkdownSchema), (c) => {
  const db = getDb()
  const input = c.req.valid('json')
  const title = input.title || extractTitle(input.markdown) || '未命名文档'

  let result: InsertDocFromMarkdownResult
  try {
    result = insertDocFromMarkdown(db, {
      notebookId: input.notebook_id,
      title,
      markdown: input.markdown,
      status: input.status,
      tags: input.tags,
      rejectEmpty: true,
    })
  } catch (e) {
    if (e instanceof EmptyMarkdownError) {
      return c.json({ error: 'bad_request', message: e.message }, 400)
    }
    throw e
  }
  const { docId, blockIds } = result

  // Hook 触发（fire-and-forget）：先 doc，再批量子块；大文档索引进度走 scheduleDocIndex
  const docRow = getBlockById(db, docId)!
  const indexJob = scheduleDocIndex(docId, blockIds)
  fireAfterCreate(rowToBlock(docRow))
  fireAfterCreateMany(getBlocksByIds(db, blockIds).map(rowToBlock))

  // asset 引用对账：悬空引用不阻断导入（可能来自其他实例的导出），但如实告知调用方
  const missingAssets = findMissingAssets(extractAssetRefs(input.markdown))

  return c.json(
    {
      doc: rowToBlock(docRow),
      block_count: blockIds.length + 1,
      ...(indexJob ? { index_job: indexJob } : {}),
      ...(missingAssets.length > 0 ? { missing_assets: missingAssets } : {}),
    },
    201,
  )
})

function extractTitle(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)/m)
  return match ? match[1].trim() : null
}

export default importRouter
