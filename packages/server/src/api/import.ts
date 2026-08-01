import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { importMarkdownSchema, rowToBlock, readDocStatus, readTags } from '@notefast/core'
import { getDb } from '../db'
import { getBlockById, getBlocksByIds } from '../store/blocks'
import { fireAfterCreate, fireAfterCreateMany, fireDocAfterCreate } from '../services/hooks'
import { emitAppEvent } from '../events'
import { extractAssetRefs, findMissingAssets } from '../assets/store'
import { EmptyMarkdownError, insertDocFromMarkdown, type InsertDocFromMarkdownResult } from '../services/docImport'
import {
  createDocFromMarkdownFile,
  DocFileImportError,
  extractTitleFromMarkdown,
} from '../services/docFileImport'
import { MAX_MARKDOWN_IMPORT_BYTES } from '../services/markdownStage'
import { scheduleDocIndex } from '../ai/indexJobs'

const importRouter = new Hono()

function respondCreated(
  result: InsertDocFromMarkdownResult,
  markdown: string,
) {
  const db = getDb()
  const docRow = getBlockById(db, result.docId)!
  const indexJob = scheduleDocIndex(result.docId, result.blockIds)
  fireAfterCreate(rowToBlock(docRow))
  fireAfterCreateMany(getBlocksByIds(db, result.blockIds).map(rowToBlock))
  fireDocAfterCreate({
    doc: rowToBlock(docRow),
    meta: { status: readDocStatus(docRow), tags: readTags(docRow), source: 'import' },
  })
  emitAppEvent({
    source: 'web',
    actor: 'admin',
    action: 'doc.imported',
    target: { type: 'doc', id: result.docId },
    outcome: 'success',
    fields: { status: readDocStatus(docRow), block_count: result.blockIds.length + 1 },
  })
  const missingAssets = findMissingAssets(extractAssetRefs(markdown))
  return {
    doc: rowToBlock(docRow),
    block_count: result.blockIds.length + 1,
    ...(indexJob ? { index_job: indexJob } : {}),
    ...(missingAssets.length > 0 ? { missing_assets: missingAssets } : {}),
  }
}

importRouter.post('/markdown', zValidator('json', importMarkdownSchema), (c) => {
  const db = getDb()
  const input = c.req.valid('json')
  const title = input.title || extractTitleFromMarkdown(input.markdown) || '未命名文档'

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

  return c.json(respondCreated(result, input.markdown), 201)
})

/**
 * multipart 文件导入：字段 file（必填）、notebook_id（必填）、title / status / tags（可选）。
 * tags 可为 JSON 数组字符串或逗号分隔。
 */
importRouter.post('/file', async (c) => {
  const body = await c.req.parseBody({ all: true })
  const notebookId = typeof body['notebook_id'] === 'string' ? body['notebook_id'].trim() : ''
  if (!notebookId) {
    return c.json({ error: 'bad_request', message: '缺少 notebook_id' }, 400)
  }

  const fileField = body['file']
  if (!fileField || typeof fileField === 'string') {
    return c.json({ error: 'bad_request', message: '缺少 file 字段（multipart 文件）' }, 400)
  }

  const file = fileField as File
  const buf = Buffer.from(await file.arrayBuffer())
  if (buf.byteLength === 0) {
    return c.json({ error: 'bad_request', message: '文件内容为空' }, 400)
  }
  if (buf.byteLength > MAX_MARKDOWN_IMPORT_BYTES) {
    return c.json({
      error: 'bad_request',
      message: `文件不得超过 ${MAX_MARKDOWN_IMPORT_BYTES} 字节`,
    }, 400)
  }

  const content = buf.toString('utf8')
  const title = typeof body['title'] === 'string' ? body['title'] : undefined
  const statusRaw = typeof body['status'] === 'string' ? body['status'] : undefined
  const status = statusRaw === 'inbox' || statusRaw === 'note' ? statusRaw : undefined
  const tags = parseTagsField(body['tags'])

  const db = getDb()
  try {
    const result = createDocFromMarkdownFile(db, {
      notebookId,
      content,
      title,
      filename: file.name || undefined,
      status,
      tags,
    })
    return c.json(respondCreated(result, result.markdown), 201)
  } catch (e) {
    if (e instanceof DocFileImportError) {
      return c.json({ error: 'bad_request', message: e.message }, 400)
    }
    throw e
  }
})

function parseTagsField(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const s = raw.trim()
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s) as unknown
      if (!Array.isArray(arr)) return undefined
      return arr.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, 64)
    } catch {
      return undefined
    }
  }
  return s.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 64)
}

export default importRouter
