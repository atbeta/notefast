import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { createHash } from 'node:crypto'
import { importMarkdownSchema, rowToBlock, readDocStatus, readTags } from '@notefast/core'
import { getDb } from '../db'
import { findDocIdBySource, getBlockById, getBlocksByIds, updateBlock } from '../store/blocks'
import { fireAfterCreate, fireAfterCreateMany, fireDocAfterCreate } from '../services/hooks'
import { emitAppEvent } from '../events'
import { scheduleSyncNow } from '../sync/protocolManager'
import { extractAssetRefs, findMissingAssets, ingestLocalImageRefs, readLocalImageCandidate, readUploadedImageCandidate } from '../assets/store'
import { EmptyMarkdownError, insertDocFromMarkdown, normalizeDocTags, type DocSourceRef, type InsertDocFromMarkdownResult } from '../services/docImport'
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

  // 打开即收编：file-open（原生壳双击/拖入）场景，把 md 里相对路径图片
  // 读同目录文件入库并重写为 asset:<sha>（否则渲染碎图）。其他来源不改写。
  let markdown = input.markdown
  let ingestedCount = 0
  if (input.source?.provider === 'file-open' && input.source.external_id) {
    const ingested = ingestLocalImageRefs(markdown, readLocalImageCandidate(input.source.external_id))
    markdown = ingested.markdown
    ingestedCount = ingested.ingested
    if (ingested.unresolved.length > 0) {
      console.warn(`[import] ${input.source.external_id}: ${ingested.unresolved.length} 张本地图片未找到，保留原引用`)
    }
  }

  const title = input.title || extractTitleFromMarkdown(markdown) || '未命名文档'

  // 打开即导入去重（壳层经 source 传文件路径）：
  // - 同 source + 同内容 hash → 重复打开同一文件，直接返回既有文档（零副作用）
  // - 同 source + 内容变了 → 新建一篇进收集箱（不覆盖应用内可能的编辑），
  //   source 身份移交新文档，旧文档剥离 source 成为普通笔记（下次打开定位到最新篇）
  let source: DocSourceRef | undefined
  if (input.source) {
    const incomingHash = createHash('sha256').update(markdown).digest('hex')
    const existingId = findDocIdBySource(db, input.source.provider, input.source.external_id)
    if (existingId) {
      const existingRow = getBlockById(db, existingId)
      const existingHash = readSourceContentHash(existingRow)
      if (existingRow && existingHash === incomingHash) {
        return c.json({ doc: rowToBlock(existingRow), deduplicated: true }, 200)
      }
      stripDocSource(db, existingId)
    }
    source = { ...input.source, content_hash: incomingHash, synced_at: new Date().toISOString() }
  }

  // notebook_id 可选：缺省落到第一个笔记本（单 Notebook 场景）；显式给出需存在。
  // 与 /import/zip 同一解析逻辑与错误行为。放在去重早退之后：deduplicated 命中保持 200 零副作用。
  const notebookId = resolveNotebookId(input.notebook_id)
  if (!notebookId) {
    return c.json({ error: 'bad_request', message: '未找到可用的笔记本' }, 400)
  }

  let result: InsertDocFromMarkdownResult
  try {
    result = insertDocFromMarkdown(db, {
      notebookId,
      title,
      markdown,
      status: input.status,
      tags: input.tags ? normalizeDocTags(input.tags) : undefined,
      rejectEmpty: true,
      source,
    })
  } catch (e) {
    if (e instanceof EmptyMarkdownError) {
      return c.json({ error: 'bad_request', message: e.message }, 400)
    }
    throw e
  }

  return c.json(
    {
      ...respondCreated(result, markdown),
      ...(ingestedCount > 0 ? { media_imported: ingestedCount } : {}),
    },
    201,
  )
})

/**
 * Web 端「从 Markdown 文件导入」（multipart）：markdown 文本 + 可选图片文件列表。
 * 图片按相对路径（webkitRelativePath / name）收编为 asset:<sha>，引用重写。
 * 解决浏览器 FileReader 只读文本、同目录图片无法上传的缺口。
 */
importRouter.post('/markdown-files', async (c) => {
  const body = await c.req.parseBody({ all: true })
  const markdownRaw = body['markdown']
  if (typeof markdownRaw !== 'string' || !markdownRaw.trim()) {
    return c.json({ error: 'bad_request', message: '缺少 markdown 文本' }, 400)
  }

  // 收集图片文件（multipart 同名 images 字段 → File[]；单文件时是 File）
  const imagesRaw = body['images']
  const imageEntries = Array.isArray(imagesRaw) ? imagesRaw : imagesRaw && typeof imagesRaw !== 'string' ? [imagesRaw] : []
  const files: Array<{ path: string; data: Buffer }> = []
  for (const img of imageEntries) {
    const f = img as File
    const buf = Buffer.from(await f.arrayBuffer())
    if (buf.length === 0) continue
    // File.name 在前端 append 时已设为相对路径（webkitRelativePath 或 name）
    files.push({ path: f.name, data: buf })
  }

  // 收编：md 相对路径图片按上传文件列表解析 → asset:<sha>
  let markdown = markdownRaw
  let ingestedCount = 0
  if (files.length > 0) {
    const ingested = ingestLocalImageRefs(markdown, readUploadedImageCandidate(files))
    markdown = ingested.markdown
    ingestedCount = ingested.ingested
    if (ingested.unresolved.length > 0) {
      console.warn(`[import/markdown-files]: ${ingested.unresolved.length} 张图片未在上传文件中找到，保留原引用`)
    }
  }

  const notebookId = resolveNotebookId(body['notebook_id'])
  if (!notebookId) {
    return c.json({ error: 'bad_request', message: '未找到可用的笔记本' }, 400)
  }

  const title =
    (typeof body['title'] === 'string' && body['title'].trim() ? body['title'].trim() : undefined)
    || extractTitleFromMarkdown(markdown)
    || '未命名文档'
  const tagsRaw = typeof body['tags'] === 'string' ? body['tags'] : undefined
  const tags = tagsRaw ? normalizeDocTags(parseTagsField(tagsRaw) ?? []) : undefined
  const db = getDb()

  let result: InsertDocFromMarkdownResult
  try {
    result = insertDocFromMarkdown(db, {
      notebookId,
      title,
      markdown,
      status: 'inbox',
      tags,
      rejectEmpty: true,
    })
  } catch (e) {
    if (e instanceof EmptyMarkdownError) {
      return c.json({ error: 'bad_request', message: e.message }, 400)
    }
    throw e
  }

  return c.json(
    {
      ...respondCreated(result, markdown),
      ...(ingestedCount > 0 ? { media_imported: ingestedCount } : {}),
    },
    201,
  )
})

/** 读文档根 properties.source.content_hash（无则 undefined） */
function readSourceContentHash(docRow: { properties: string } | null): string | undefined {
  if (!docRow) return undefined
  try {
    const props = JSON.parse(docRow.properties) as { source?: { content_hash?: string } }
    return props.source?.content_hash
  } catch {
    return undefined
  }
}

/** 从文档根剥离 source 标识（身份移交新文档后，旧文档成为普通笔记） */
function stripDocSource(db: ReturnType<typeof getDb>, docId: string): void {
  const row = getBlockById(db, docId)
  if (!row) return
  try {
    const props = JSON.parse(row.properties) as Record<string, unknown>
    if (!('source' in props)) return
    delete props.source
    updateBlock(db, docId, { properties: JSON.stringify(props) })
  } catch { /* properties 损坏时保持原样 */ }
}

/**
 * multipart 文件导入：字段 file（必填）、notebook_id（必填）、title / status / tags（可选）。
 * tags 可为 JSON 数组字符串或逗号分隔；入库前统一 normalize（lowercase + 空白转连字符，同 POST /docs）。
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
  const parsedTags = parseTagsField(body['tags'])
  const tags = parsedTags ? normalizeDocTags(parsedTags) : undefined

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
