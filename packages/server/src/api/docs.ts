import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { createDocSchema, buildBlockTree, buildHeadingTree, blocksToMarkdown, parseMarkdownToBlocks, stripTitleHeading, updateDocMarkdownSchema, updateDocStatusSchema, rowToBlock, readTags, readAiExclude, readDocStatus, isDocInbox, isDocArchived, getTagProvider, parseTagsQueryParam, parseTagMatchMode, parseUpdatedWithin, parseDocStatusFilter, docMatchesTags, parseCreatedWithin, parseStaleWithin } from '@notefast/core'
import type { DocSummary } from '@notefast/core'
import { getDb } from '../db'
import {
  fetchDocBlocks,
  fetchSubtreeBlocks,
  getBlockById,
  getDocById,
  getLiveDocById,
  getBlocksByIds,
  listDocRows,
  updateBlock,
  softDeleteBlocks,
  nowTimestamp,
} from '../store/blocks'
import { deleteRefsTouchingBlocks } from '../store/refs'
import { insertDocFromMarkdown, insertChildBlocks } from '../services/docImport'
import { fireAfterCreate, fireAfterUpdate, fireAfterDelete, fireAfterCreateMany, fireAfterDeleteMany } from '../services/hooks'
import { extractAssetRefs, findMissingAssets } from '../assets/store'
import { writeDocAiExclude, applyAiExcludeChange } from '../ai/aiExclude'
import { readDocAiExclude } from '../ai/aiExcludeQuery'
import { scheduleDocIndex } from '../ai/indexJobs'

const docs = new Hono()

docs.get('/list', (c) => {
  const db = getDb()
  const notebookId = c.req.query('notebook_id') || ''
  const selectedTags = parseTagsQueryParam(c.req.query('tags'), c.req.query('tag'))
  const tagMatch = parseTagMatchMode(c.req.query('tag_match'))
  const untagged = c.req.query('untagged') === '1' || c.req.query('untagged') === 'true'
  const withinMs = parseUpdatedWithin(c.req.query('updated_within'))
  const statusFilter = parseDocStatusFilter(c.req.query('status'))

  let rows = listDocRows(db, { notebookId: notebookId || undefined })

  // 生命周期：默认只列正式笔记（排除收集箱与归档）；status=inbox/archived 只列对应集合；all 不过滤
  if (statusFilter === 'inbox') {
    rows = rows.filter((r) => isDocInbox(r))
  } else if (statusFilter === 'archived') {
    rows = rows.filter((r) => isDocArchived(r))
  } else if (statusFilter === 'note') {
    rows = rows.filter((r) => readDocStatus(r) === 'note')
  }

  // 标签 / 时间过滤在 Node 端做（文档量小，不值得加 SQL JSON 函数）
  if (untagged) {
    rows = rows.filter((r) => readTags(r).length === 0)
  } else if (selectedTags.length > 0) {
    rows = rows.filter((r) => docMatchesTags(readTags(r), selectedTags, tagMatch))
  }

  if (withinMs != null) {
    const cutoff = Date.now() - withinMs
    rows = rows.filter((r) => {
      const ts = new Date(r.updated_at).getTime()
      return Number.isFinite(ts) && ts >= cutoff
    })
  }

  const createdMs = parseCreatedWithin(c.req.query('created_within'))
  if (createdMs != null) {
    const cutoff = Date.now() - createdMs
    rows = rows.filter((r) => {
      const ts = new Date(r.created_at).getTime()
      return Number.isFinite(ts) && ts >= cutoff
    })
  }

  const staleMs = parseStaleWithin(c.req.query('stale_within'))
  if (staleMs != null) {
    const cutoff = Date.now() - staleMs
    rows = rows.filter((r) => {
      const ts = new Date(r.updated_at).getTime()
      return Number.isFinite(ts) && ts <= cutoff
    })
  }

  if (c.req.query('ai_exclude') === '1') {
    rows = rows.filter((r) => readAiExclude(r))
  }

  const summaries: DocSummary[] = rows.map((r) => {
    const tags = readTags(r)
    const aiExclude = readAiExclude(r)
    const status = readDocStatus(r)
    return {
      id: r.id,
      title: r.content,
      created_at: r.created_at,
      updated_at: r.updated_at,
      tags,
      ...(aiExclude ? { ai_exclude: true } : {}),
      ...(status !== 'note' ? { status } : {}),
    }
  })

  return c.json(summaries)
})

docs.get('/tree', (c) => {
  const db = getDb()
  const docId = c.req.query('doc_id')

  if (!docId) {
    return c.json({ error: 'bad_request', message: '缺少 doc_id 参数' }, 400)
  }

  const docRow = getDocById(db, docId)
  if (!docRow) {
    return c.json({ error: 'not_found', message: `文档 ${docId} 不存在` }, 404)
  }

  const tree = buildBlockTree(fetchDocBlocks(db, docId))

  if (tree.length === 0) {
    return c.json([])
  }

  const headings = buildHeadingTree(tree[0].children || [])
  return c.json(headings)
})

docs.get('/:id', (c) => {
  const db = getDb()
  const id = c.req.param('id')

  const docRow = getDocById(db, id)
  if (!docRow) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }

  const tree = buildBlockTree(fetchDocBlocks(db, id))

  return c.json(tree.length > 0 ? tree[0] : null)
})

docs.post('/', zValidator('json', createDocSchema), (c) => {
  const db = getDb()
  const input = c.req.valid('json')
  const status = input.status === 'inbox' ? 'inbox' : 'note'
  const normalizeTag = (t: string) => t.toLowerCase().replace(/\s+/g, '-').slice(0, 64)
  const initialTags = (input.tags || []).map(normalizeTag).filter(Boolean)
  const { docId, blockIds } = insertDocFromMarkdown(db, {
    notebookId: input.notebook_id,
    title: input.title,
    markdown: input.markdown || '',
    status,
    tags: initialTags,
  })

  const row = getBlockById(db, docId)!
  const indexJob = scheduleDocIndex(docId, blockIds)
  fireAfterCreate(rowToBlock(row))
  fireAfterCreateMany(getBlocksByIds(db, blockIds).map(rowToBlock))
  return c.json({
    id: row.id,
    title: row.content,
    created_at: row.created_at,
    updated_at: row.updated_at,
    tags: initialTags,
    ...(status === 'inbox' ? { status: 'inbox' as const } : {}),
    ...(indexJob ? { index_job: indexJob } : {}),
  }, 201)
})

docs.patch('/:id/status', zValidator('json', updateDocStatusSchema), (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const { status } = c.req.valid('json')

  const docRow = getDocById(db, id)
  if (!docRow) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }

  updateBlock(db, id, { status })

  const updatedRow = getBlockById(db, id)!
  fireAfterUpdate(rowToBlock(updatedRow))
  return c.json({
    doc_id: id,
    status: readDocStatus(updatedRow),
    updated_at: updatedRow.updated_at,
  })
})

docs.patch('/:id/tags', async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => ({}))) as { tags?: unknown }
  const rawTags = Array.isArray(body.tags) ? body.tags : []
  const newTags = rawTags.filter((t): t is string => typeof t === 'string').slice(0, 64)

  const docRow = getDocById(db, id)
  if (!docRow) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }

  const provider = getTagProvider()
  const updated = provider.setDocTags(docRow, newTags)
  updateBlock(db, id, { tags: updated.tags })

  const finalTags = provider.getDocTags(updated)
  const updatedRow = getBlockById(db, id)!
  return c.json({
    doc_id: id,
    tags: finalTags,
    updated_at: updatedRow.updated_at,
  })
})

const aiExcludeSchema = z.object({
  ai_exclude: z.boolean(),
})

docs.patch('/:id/ai-exclude', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const parsed = aiExcludeSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'bad_request', message: '需要 boolean 字段 ai_exclude' }, 400)
  }

  const oldExclude = readDocAiExclude(id)
  if (oldExclude === null) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }

  const updated = writeDocAiExclude(id, parsed.data.ai_exclude)
  if (!updated) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }

  const effect = await applyAiExcludeChange(id, oldExclude, parsed.data.ai_exclude)

  return c.json({
    doc_id: id,
    ai_exclude: readAiExclude(updated),
    updated_at: updated.updated_at,
    ...(effect ? { effect } : {}),
  })
})

docs.delete('/:id', (c) => {
  const db = getDb()
  const id = c.req.param('id')

  const docRow = getLiveDocById(db, id)
  if (!docRow) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }

  const childIds = fetchSubtreeBlocks(db, id)
  const allIds = [id, ...childIds.map((r) => r.id)]

  db.transaction(() => {
    deleteRefsTouchingBlocks(db, allIds)
    softDeleteBlocks(db, allIds)
  })()

  fireAfterDelete(id)
  return c.json({ deleted: true, count: allIds.length })
})

docs.put('/:id/markdown', zValidator('json', updateDocMarkdownSchema), (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const { markdown, title } = c.req.valid('json')

  const docRow = getDocById(db, id)
  if (!docRow) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }

  const rawInputs = parseMarkdownToBlocks(markdown, docRow.notebook_id)
  // 剥离与标题重复的首个 H1（导出的 markdown 首行是 `# {标题}`，直接回解析会重复入库）
  const newTitle = title || docRow.content
  const inputs = stripTitleHeading(rawInputs, newTitle)

  // 收集旧子块 ID（事务外保留引用，事务后触发 afterDelete）
  const oldChildRows = fetchSubtreeBlocks(db, id)
  const oldChildIds = oldChildRows.map((r) => r.id)
  // 收集新插入的 block rows（事务后 SELECT 拿到最终时间戳）
  const insertedIds: string[] = []

  db.transaction(() => {
    deleteRefsTouchingBlocks(db, oldChildIds)
    softDeleteBlocks(db, oldChildIds)

    updateBlock(db, id, { content: newTitle })

    // 与 insertDocFromMarkdown / appendMarkdownToDoc 共用插入逻辑：
    // properties（headingLevel/language 等）与嵌套 level 不再丢失
    insertedIds.push(
      ...insertChildBlocks(db, {
        notebookId: docRow.notebook_id,
        rootId: id,
        inputs,
        sortOffset: 0,
        now: nowTimestamp(),
      }),
    )
  })()

  // Hook 触发（fire-and-forget）：删旧 → 文档级索引作业 → 增新 hooks → 更 doc
  fireAfterDeleteMany(oldChildIds)
  const indexJob = scheduleDocIndex(id, insertedIds)
  fireAfterCreateMany(getBlocksByIds(db, insertedIds).map(rowToBlock))
  const updatedDocRow = getBlockById(db, id)!
  fireAfterUpdate(rowToBlock(updatedDocRow))

  const tree = buildBlockTree(fetchDocBlocks(db, id))
  // asset 引用对账：悬空引用告警（不阻断保存）
  const missingAssets = findMissingAssets(extractAssetRefs(markdown))
  return c.json({
    doc: tree.length > 0 ? tree[0] : null,
    ...(indexJob ? { index_job: indexJob } : {}),
    ...(missingAssets.length > 0 ? { missing_assets: missingAssets } : {}),
  })
})

docs.get('/:id/export/markdown', (c) => {
  const id = c.req.param('id')
  const db = getDb()

  const docRow = getDocById(db, id)
  if (!docRow) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }

  const tree = buildBlockTree(fetchDocBlocks(db, id))

  const markdown = blocksToMarkdown(tree)
  return c.json({ markdown })
})

export default docs
