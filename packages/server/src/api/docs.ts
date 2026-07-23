import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { createDocSchema, buildBlockTree, buildHeadingTree, blocksToMarkdown, parseMarkdownToBlocks, stripTitleHeading, updateDocMarkdownSchema, updateDocStatusSchema, rowToBlock, readTagsFromProperties, readAiExcludeFromProperties, readDocStatusFromProperties, setDocStatusInProperties, isInboxDoc, getTagProvider, parseTagsQueryParam, parseTagMatchMode, parseUpdatedWithin, parseDocStatusFilter, docMatchesTags } from '@notefast/core'
import type { BlockRow, DocSummary } from '@notefast/core'
import { getDb } from '../db'
import { fetchDocBlocks, fetchSubtreeBlocks } from '../dbQueries'
import { insertDocFromMarkdown } from '../services/docImport'
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

  let rows: BlockRow[]
  if (notebookId) {
    rows = db
      .query('SELECT * FROM blocks WHERE type = ? AND notebook_id = ? ORDER BY updated_at DESC')
      .all('document', notebookId) as BlockRow[]
  } else {
    rows = db
      .query('SELECT * FROM blocks WHERE type = ? ORDER BY updated_at DESC')
      .all('document') as BlockRow[]
  }

  // 生命周期：默认只列正式笔记；status=inbox 只列收集箱；all 不过滤
  if (statusFilter === 'inbox') {
    rows = rows.filter((r) => isInboxDoc(r.properties))
  } else if (statusFilter === 'note') {
    rows = rows.filter((r) => !isInboxDoc(r.properties))
  }

  // 标签 / 时间过滤在 Node 端做（文档量小，不值得加 SQL JSON 函数）
  if (untagged) {
    rows = rows.filter((r) => readTagsFromProperties(r.properties).length === 0)
  } else if (selectedTags.length > 0) {
    rows = rows.filter((r) => docMatchesTags(readTagsFromProperties(r.properties), selectedTags, tagMatch))
  }

  if (withinMs != null) {
    const cutoff = Date.now() - withinMs
    rows = rows.filter((r) => {
      const ts = new Date(r.updated_at).getTime()
      return Number.isFinite(ts) && ts >= cutoff
    })
  }

  const summaries: DocSummary[] = rows.map((r) => {
    const tags = readTagsFromProperties(r.properties)
    const aiExclude = readAiExcludeFromProperties(r.properties)
    const status = readDocStatusFromProperties(r.properties)
    return {
      id: r.id,
      title: r.content,
      created_at: r.created_at,
      updated_at: r.updated_at,
      tags,
      ...(aiExclude ? { ai_exclude: true } : {}),
      ...(status === 'inbox' ? { status: 'inbox' as const } : {}),
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

  const docRow = db.query('SELECT * FROM blocks WHERE id = ? AND type = ?').get(docId, 'document') as BlockRow | undefined
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

  const docRow = db.query('SELECT * FROM blocks WHERE id = ? AND type = ?').get(id, 'document') as BlockRow | undefined
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
  const { docId, blockIds } = insertDocFromMarkdown(db, {
    notebookId: input.notebook_id,
    title: input.title,
    markdown: input.markdown || '',
    status,
  })

  const row = db.query('SELECT * FROM blocks WHERE id = ?').get(docId) as BlockRow
  const indexJob = scheduleDocIndex(docId, blockIds)
  fireAfterCreate(rowToBlock(row))
  if (blockIds.length > 0) {
    const placeholders = blockIds.map(() => '?').join(',')
    const childRows = db
      .query(`SELECT * FROM blocks WHERE id IN (${placeholders})`)
      .all(...blockIds) as BlockRow[]
    fireAfterCreateMany(childRows.map(rowToBlock))
  }
  return c.json({
    id: row.id,
    title: row.content,
    created_at: row.created_at,
    updated_at: row.updated_at,
    tags: [],
    ...(status === 'inbox' ? { status: 'inbox' as const } : {}),
    ...(indexJob ? { index_job: indexJob } : {}),
  }, 201)
})

docs.patch('/:id/status', zValidator('json', updateDocStatusSchema), (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const { status } = c.req.valid('json')

  const docRow = db
    .query("SELECT * FROM blocks WHERE id = ? AND type = 'document'")
    .get(id) as BlockRow | undefined
  if (!docRow) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }

  const properties = setDocStatusInProperties(docRow.properties, status)
  db.query(
    "UPDATE blocks SET properties = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(properties, id)

  const updatedRow = db.query('SELECT * FROM blocks WHERE id = ?').get(id) as BlockRow
  fireAfterUpdate(rowToBlock(updatedRow))
  return c.json({
    doc_id: id,
    status: readDocStatusFromProperties(updatedRow.properties),
    updated_at: updatedRow.updated_at,
  })
})

docs.patch('/:id/tags', async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => ({}))) as { tags?: unknown }
  const rawTags = Array.isArray(body.tags) ? body.tags : []
  const newTags = rawTags.filter((t): t is string => typeof t === 'string').slice(0, 64)

  const docRow = db
    .query("SELECT * FROM blocks WHERE id = ? AND type = 'document'")
    .get(id) as BlockRow | undefined
  if (!docRow) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }

  const provider = getTagProvider()
  const updated = provider.setDocTags(docRow, newTags)
  db.query(
    "UPDATE blocks SET properties = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(updated.properties, id)

  const finalTags = provider.getDocTags(updated)
  const updatedRow = db.query('SELECT * FROM blocks WHERE id = ?').get(id) as BlockRow
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
    ai_exclude: readAiExcludeFromProperties(updated.properties),
    updated_at: updated.updated_at,
    ...(effect ? { effect } : {}),
  })
})

docs.delete('/:id', (c) => {
  const db = getDb()
  const id = c.req.param('id')

  const docRow = db.query('SELECT * FROM blocks WHERE id = ? AND type = ?').get(id, 'document') as BlockRow | undefined
  if (!docRow) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }

  const childIds = fetchSubtreeBlocks(db, id)
  const allIds = [id, ...childIds.map((r) => r.id)]

  db.transaction(() => {
    for (const delId of allIds) {
      db.query('DELETE FROM block_refs WHERE source_id = ? OR target_id = ?').run(delId, delId)
    }
    const placeholders = allIds.map(() => '?').join(',')
    db.query(`DELETE FROM blocks WHERE id IN (${placeholders})`).run(...allIds)
  })()

  fireAfterDelete(id)
  return c.json({ deleted: true, count: allIds.length })
})

docs.put('/:id/markdown', zValidator('json', updateDocMarkdownSchema), (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const { markdown, title } = c.req.valid('json')

  const docRow = db.query('SELECT * FROM blocks WHERE id = ? AND type = ?').get(id, 'document') as BlockRow | undefined
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
    for (const delId of oldChildIds) {
      db.query('DELETE FROM block_refs WHERE source_id = ? OR target_id = ?').run(delId, delId)
    }
    if (oldChildIds.length > 0) {
      const placeholders = oldChildIds.map(() => '?').join(',')
      db.query(`DELETE FROM blocks WHERE id IN (${placeholders})`).run(...oldChildIds)
    }

    db.query("UPDATE blocks SET content = ?, updated_at = datetime('now') WHERE id = ?").run(newTitle, id)

    const now = new Date().toISOString()
    const idMap = new Map<string, string>()

    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i]
      const blockId = crypto.randomUUID()
      if (inp.id) idMap.set(inp.id, blockId)
      const parentId = inp.parent_id ? (idMap.get(inp.parent_id) ?? id) : id

      db.query(
        `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, properties, sort, level, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        blockId,
        docRow.notebook_id,
        parentId,
        id,
        inp.type,
        inp.content ?? '',
        JSON.stringify(inp.properties || {}),
        i,
        now,
        now,
      )
      insertedIds.push(blockId)
    }
  })()

  // Hook 触发（fire-and-forget）：删旧 → 文档级索引作业 → 增新 hooks → 更 doc
  fireAfterDeleteMany(oldChildIds)
  const indexJob = scheduleDocIndex(id, insertedIds)
  if (insertedIds.length > 0) {
    const placeholders = insertedIds.map(() => '?').join(',')
    const newRows = db
      .query(`SELECT * FROM blocks WHERE id IN (${placeholders})`)
      .all(...insertedIds) as BlockRow[]
    fireAfterCreateMany(newRows.map(rowToBlock))
  }
  const updatedDocRow = db.query('SELECT * FROM blocks WHERE id = ?').get(id) as BlockRow
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

  const docRow = db.query('SELECT * FROM blocks WHERE id = ? AND type = ?').get(id, 'document') as BlockRow | undefined
  if (!docRow) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }

  const tree = buildBlockTree(fetchDocBlocks(db, id))

  const markdown = blocksToMarkdown(tree)
  return c.json({ markdown })
})

export default docs
