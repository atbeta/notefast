import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { importMarkdownSchema, rowToBlock, readDocStatus, readTags } from '@notefast/core'
import { getDb } from '../db'
import { getBlockById, getBlocksByIds } from '../store/blocks'
import { fireAfterCreate, fireAfterCreateMany, fireDocAfterCreate } from '../services/hooks'
import { emitAppEvent } from '../events'
import { scheduleSyncNow } from '../sync/protocolManager'
import { extractAssetRefs, findMissingAssets } from '../assets/store'
import { EmptyMarkdownError, insertDocFromMarkdown, type InsertDocFromMarkdownResult } from '../services/docImport'
import {
  createDocFromMarkdownFile,
  DocFileImportError,
  extractTitleFromMarkdown,
} from '../services/docFileImport'
import { MAX_MARKDOWN_IMPORT_BYTES } from '../services/markdownStage'
import { MAX_ARCHIVE_IMPORT_BYTES, importArchiveZip } from '../services/zipImport'
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
  scheduleSyncNow()
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

/** 解析 notebook_id：显式给出需存在；缺省用第一个笔记本（单 Notebook 场景） */
function resolveNotebookId(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.trim()) {
    const row = getDb().query('SELECT id FROM notebooks WHERE id = ?').get(raw.trim()) as { id: string } | undefined
    return row?.id ?? null
  }
  const row = getDb()
    .query('SELECT id FROM notebooks ORDER BY sort ASC, created_at ASC LIMIT 1')
    .get() as { id: string } | undefined
  return row?.id ?? null
}

/**
 * 导入 zip 存档：自家导出档（manifest 精确还原）或通用 md zip。
 * 入库后为新文档触发索引与 hooks（autolink / 实体抽取等）。
 */
importRouter.post('/zip', async (c) => {
  const body = await c.req.parseBody({ all: true })
  const fileField = body['file']
  if (!fileField || typeof fileField === 'string') {
    return c.json({ error: 'bad_request', message: '缺少 file 字段（multipart zip 文件）' }, 400)
  }
  const file = fileField as File
  const buf = Buffer.from(await file.arrayBuffer())
  if (buf.byteLength === 0) {
    return c.json({ error: 'bad_request', message: '文件内容为空' }, 400)
  }
  if (buf.byteLength > MAX_ARCHIVE_IMPORT_BYTES) {
    return c.json({
      error: 'bad_request',
      message: `文件不得超过 ${MAX_ARCHIVE_IMPORT_BYTES} 字节`,
    }, 400)
  }

  const notebookId = resolveNotebookId(body['notebook_id'])
  if (!notebookId) {
    return c.json({ error: 'bad_request', message: '未找到可用的笔记本' }, 400)
  }

  let result: ReturnType<typeof importArchiveZip>
  try {
    result = importArchiveZip(getDb(), { notebookId, bytes: new Uint8Array(buf) })
  } catch (e) {
    return c.json({ error: 'bad_request', message: e instanceof Error ? e.message : String(e) }, 400)
  }

  // 新文档触发索引与 hooks（fire-and-forget，量级与单篇导入一致）
  const db = getDb()
  for (const doc of result.importedDocs) {
    const docRow = getBlockById(db, doc.docId)
    if (!docRow) continue
    scheduleDocIndex(doc.docId, doc.blockIds)
    fireAfterCreateMany(getBlocksByIds(db, doc.blockIds).map(rowToBlock))
    fireDocAfterCreate({
      doc: rowToBlock(docRow),
      meta: { status: 'note', tags: readTags(docRow), source: 'import' },
    })
  }
  if (result.importedDocs.length > 0) scheduleSyncNow()

  return c.json({
    imported: result.imported,
    skipped: result.skipped,
    failed: result.failed,
    media_imported: result.mediaImported,
    errors: result.errors.slice(0, 20),
  }, 200)
})

export default importRouter
