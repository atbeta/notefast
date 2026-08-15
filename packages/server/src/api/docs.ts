import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { createDocSchema, buildBlockTree, buildHeadingTree, blocksToMarkdown, parseMarkdownToBlocks, stripTitleHeading, updateDocMarkdownSchema, updateDocStatusSchema, rowToBlock, readTags, readAiExclude, readDocStatus, isDocInbox, isDocArchived, getTagProvider, parseTagsQueryParam, parseTagMatchMode, parseUpdatedWithin, parseDocStatusFilter, docMatchesTags, parseCreatedWithin, parseStaleWithin } from '@notefast/core'
import type { DocSummary } from '@notefast/core'
import { getDb } from '../db'
import {
  fetchDocBlocks,
  fetchDocBlockIds,
  fetchSubtreeBlocks,
  getBlockById,
  getDocById,
  getLiveDocById,
  getDocNeighbors,
  getBlocksByIds,
  listDocRows,
  updateBlock,
  softDeleteBlocks,
  listDocRevisions,
  recordDocSnapshot,
  getDocSnapshot,
  nowTimestamp,
} from '../store/blocks'
import { deleteRefsTouchingBlocks } from '../store/refs'
import { deleteMentionsTouchingBlocks } from '../store/entities'
import { deleteShare, deleteSharesByDocIds, listSharedDocIds } from '../store/shares'
import { insertDocFromMarkdown, insertChildBlocks, normalizeDocTags } from '../services/docImport'
import { fireAfterCreate, fireAfterUpdate, fireAfterCreateMany, fireAfterDeleteMany, fireDocAfterCreate, fireDocAfterStatusChange, fireDocAfterTagChange, fireDocAfterDelete, auditDocAction } from '../services/hooks'
import { extractAssetRefs, findMissingAssets } from '../assets/store'
import { writeDocAiExclude, applyAiExcludeChange } from '../ai/aiExclude'
import { readDocAiExclude } from '../ai/aiExcludeQuery'
import { reanalyzeDoc } from '../ai/autoLink'
import { scheduleDocIndex } from '../ai/indexJobs'
import { buildDocExportFile, contentDispositionAttachment } from '../services/docExport'
import { registerShareRoutes } from './docShare'
import { registerTrashRoutes } from './docTrash'
import { listRelatedDocs } from '../services/docRelated'
import { scheduleSyncNow } from '../sync/protocolManager'

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

  const sharedDocIds = listSharedDocIds(db)

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
      ...(sharedDocIds.has(r.id) ? { shared: true } : {}),
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

// 回收站：软删除文档列表（恢复走 POST /blocks/:id/restore，整子树恢复）。
// 必须注册在 /:id 之前，否则 'trash' 被当作文档 id。
// 回收站路由（GET/DELETE /trash、DELETE /:id/permanent）：
// 必须先于 /:id 注册（'trash' 会被 :id 吞掉），整体提前到这里
registerTrashRoutes(docs)

/** 侧栏徽章计数：一次请求返回各集合文档数（与 /list 同谓词，Node 端统计） */
docs.get('/counts', (c) => {
  const db = getDb()
  const rows = listDocRows(db, {})
  let inbox = 0
  let archived = 0
  let untagged = 0
  let aiExclude = 0
  for (const r of rows) {
    const status = readDocStatus(r)
    if (status === 'inbox') inbox++
    else if (status === 'archived') archived++
    if (readTags(r).length === 0) untagged++
    if (readAiExclude(r)) aiExclude++
  }
  const trashRow = db
    .query("SELECT count(*) AS c FROM blocks WHERE type = 'document' AND is_deleted = 1")
    .get() as { c: number }
  return c.json({ inbox, archived, untagged, ai_exclude: aiExclude, trash: trashRow.c })
})

/** 文档顺序导航：按 created_at 顺序的上一篇/下一篇（Obsidian 式箭头；单篇两侧 null） */
docs.get('/:id/neighbors', (c) => {
  const db = getDb()
  const id = c.req.param('id')
  if (!getLiveDocById(db, id)) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }
  return c.json(getDocNeighbors(db, id))
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

/**
 * 语义邻居（右栏「相关」）：hybridSearch(标题+tags, contextDocId) → 文档级列表，排除自身。
 */
docs.get('/:id/related', async (c) => {
  const id = c.req.param('id')
  const limitRaw = parseInt(c.req.query('limit') || '8', 10)
  const limit = Number.isFinite(limitRaw) ? limitRaw : 8
  try {
    const result = await listRelatedDocs(id, { limit })
    if (!result) {
      return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
    }
    return c.json(result)
  } catch (e) {
    return c.json(
      {
        error: 'search_error',
        message: e instanceof Error ? e.message : String(e),
      },
      500,
    )
  }
})

docs.post('/', zValidator('json', createDocSchema), (c) => {
  const db = getDb()
  const input = c.req.valid('json')
  const status = input.status === 'inbox' ? 'inbox' : 'note'
  const initialTags = normalizeDocTags(input.tags || [])
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
  fireDocAfterCreate({
    doc: rowToBlock(row),
    meta: { status, tags: initialTags, source: 'http' },
  })
  auditDocAction('doc.created', docId, { status, tag_count: initialTags.length })
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
  const oldStatus = readDocStatus(docRow)

  // 状态翻转与归档级联关闭分享需原子：任一失败整体回滚，
  // 不留「已归档但公开链接仍有效」的中间态
  let shareRevoked = false
  db.transaction(() => {
    updateBlock(db, id, { status })
    // 归档 = 退出活跃流通：与删除保持一致，级联关闭公开分享（旧链接立即 404）。
    // 恢复为 note 不复活旧链接，需重新开启（与删除路径语义一致）
    if (status === 'archived') {
      shareRevoked = deleteShare(db, id)
    }
  })()

  // 升格（inbox/archived → note）：文档重新进入流通，全 doc 重抽补齐实体与链
  // （fireAfterUpdate 只触发文档根，子块不经 hook；fire-and-forget，限速自然生效）
  if (status === 'note' && (oldStatus === 'inbox' || oldStatus === 'archived')) {
    reanalyzeDoc(id)
  }

  const updatedRow = getBlockById(db, id)!
  fireAfterUpdate(rowToBlock(updatedRow))
  fireDocAfterStatusChange({
    doc: rowToBlock(updatedRow),
    before: { status: oldStatus },
    meta: { status, share_revoked: shareRevoked },
  })
  auditDocAction('doc.status_changed', id, { from: oldStatus, to: status, share_revoked: shareRevoked })
  return c.json({
    doc_id: id,
    status: readDocStatus(updatedRow),
    updated_at: updatedRow.updated_at,
    ...(shareRevoked ? { share_revoked: true } : {}),
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
  const oldTags = readTags(docRow)
  const updated = provider.setDocTags(docRow, newTags)
  updateBlock(db, id, { tags: updated.tags, touchUpdatedAt: false })

  // 标签进入索引文本上下文：保存后整篇重索引（hasFreshVector 跳过未变块；
  // autoIndex 关闭或 embedding 未配时 scheduleDocIndex 返回 null，无需特判）；
  // 调度只需 id 列表，不再为拿 id 拉全文档字段
  scheduleDocIndex(id, fetchDocBlockIds(db, id))

  const finalTags = provider.getDocTags(updated)
  const updatedRow = getBlockById(db, id)!
  fireDocAfterTagChange({
    doc: rowToBlock(updatedRow),
    before: { tags: oldTags },
    meta: {
      tags: finalTags,
      added: finalTags.filter((t) => !oldTags.includes(t)),
      removed: oldTags.filter((t) => !finalTags.includes(t)),
    },
  })
  auditDocAction('doc.tags_changed', id, {
    tag_count: finalTags.length,
    added: finalTags.filter((t) => !oldTags.includes(t)).length,
    removed: oldTags.filter((t) => !finalTags.includes(t)).length,
  })
  return c.json({
    doc_id: id,
    tags: finalTags,
    updated_at: updatedRow.updated_at,
  })
})

const aiExcludeSchema = z.object({
  ai_exclude: z.boolean(),
})

// 分享（公开只读链接）路由：从 api/docShare.ts 注册
registerShareRoutes(docs)

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
    deleteMentionsTouchingBlocks(db, allIds)
    softDeleteBlocks(db, allIds)
    // 删除即切断公开链接（恢复文档不复活旧 token，需重新开启）
    deleteSharesByDocIds(db, [id])
  })()

  // 逐块触发 afterDelete（含文档根 + 全部子块）：向量/级联清理依赖它。
  // 只 fire 文档根会漏掉子块 —— block_vectors 里残留孤儿向量（查询被 is_deleted 隔离
  // 但存储与计数不清零）。
  fireAfterDeleteMany(allIds)
  fireDocAfterDelete({ doc: rowToBlock(docRow) })
  auditDocAction('doc.deleted', id, { block_count: allIds.length })
  return c.json({ deleted: true, count: allIds.length })
})

/**
 * 整篇替换（编辑器保存 / 整篇快照回退共用）：
 * - 事务内先记「保存前整篇快照」（doc_snapshots），再删旧子块 + 插新子块 —— 原子，失败不留脏快照
 * - 标题变更不单独记块级修订（快照已含旧标题）
 * - 返回响应体数据 + 副作用（索引作业 / hooks 已在此触发）
 */
function applyMarkdownReplace(
  db: ReturnType<typeof getDb>,
  id: string,
  markdown: string,
  title: string | undefined,
  actor: string,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const docRow = getDocById(db, id)
  if (!docRow) {
    return { ok: false, error: `文档 ${id} 不存在` }
  }

  const rawInputs = parseMarkdownToBlocks(markdown, docRow.notebook_id)
  // 剥离与标题重复的首个 H1（导出的 markdown 首行是 `# {标题}`，直接回解析会重复入库）
  const newTitle = title || docRow.content
  const inputs = stripTitleHeading(rawInputs, newTitle)

  // 整篇替换会删旧子块 + 插新子块（绕过块级 updateBlock 的 revision），
  // 先把旧整篇合并为一条「保存前快照」（在事务内写入 —— 后续任一失败自动回滚，不留脏快照）
  const oldMarkdown = blocksToMarkdown(buildBlockTree(fetchDocBlocks(db, id)))

  // 收集旧子块 ID（事务外保留引用，事务后触发 afterDelete）
  const oldChildRows = fetchSubtreeBlocks(db, id)
  const oldChildIds = oldChildRows.map((r) => r.id)
  // 收集新插入的 block rows（事务后 SELECT 拿到最终时间戳）
  const insertedIds: string[] = []

  db.transaction(() => {
    recordDocSnapshot(db, id, oldMarkdown, actor)
    deleteRefsTouchingBlocks(db, oldChildIds)
    deleteMentionsTouchingBlocks(db, oldChildIds)
    softDeleteBlocks(db, oldChildIds)

    // 标题变更不单独记 revision（整篇快照已含旧标题，见 recordDocSnapshot 上方注释）
    updateBlock(db, id, { content: newTitle, noRevision: true })

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
  // 编辑器整篇保存：去抖自动同步（fire-and-forget，未配置时静默跳过）
  scheduleSyncNow()

  const tree = buildBlockTree(fetchDocBlocks(db, id))
  // asset 引用对账：悬空引用告警（不阻断保存）
  const missingAssets = findMissingAssets(extractAssetRefs(markdown))
  return {
    ok: true,
    body: {
      doc: tree.length > 0 ? tree[0] : null,
      updated_at: updatedDocRow.updated_at,
      ...(indexJob ? { index_job: indexJob } : {}),
      ...(missingAssets.length > 0 ? { missing_assets: missingAssets } : {}),
    },
  }
}

docs.put('/:id/markdown', zValidator('json', updateDocMarkdownSchema), (c) => {
  const { markdown, title } = c.req.valid('json')
  const result = applyMarkdownReplace(getDb(), c.req.param('id'), markdown, title, 'editor')
  return result.ok ? c.json(result.body) : c.json({ error: 'not_found', message: result.error }, 404)
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
  return c.json({ markdown, updated_at: docRow.updated_at })
})

/** 文档级历史：跨块 revision 时间线（含标题与子块），按时间新→旧 */
docs.get('/:id/revisions', (c) => {
  const id = c.req.param('id')
  // 非数字 limit（Number → NaN）会被传进 SQLite LIMIT 抛 500，守卫后回退默认值
  const limitRaw = Number(c.req.query('limit') ?? 100)
  const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : 100
  const db = getDb()

  const docRow = getDocById(db, id)
  if (!docRow) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }
  return c.json({ doc_id: id, revisions: listDocRevisions(db, id, limit) })
})

/** 回退到指定整篇快照：以该快照内容做一次整篇替换（actor='revert'，同样留一条「回退前」快照） */
docs.post('/:id/snapshots/:rev/restore', (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const rev = Number(c.req.param('rev'))

  const docRow = getDocById(db, id)
  if (!docRow) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }
  if (!Number.isInteger(rev) || rev < 1) {
    return c.json({ error: 'invalid_params', message: `rev 必须是正整数` }, 400)
  }
  const snapshot = getDocSnapshot(db, id, rev)
  if (!snapshot) {
    return c.json({ error: 'not_found', message: `文档 ${id} 的快照 ${rev} 不存在` }, 404)
  }

  // 快照内容本身就是完整 markdown（含标题），整篇替换会解析并重建块树
  const result = applyMarkdownReplace(db, id, snapshot.content, undefined, 'revert')
  return result.ok ? c.json(result.body) : c.json({ error: 'not_found', message: result.error }, 404)
})

/**
 * 单文档文件下载：无图 → .md；有可用图片 → .zip（Markdown + media/，asset: 改写为相对路径）。
 * 编辑器加载仍走 /export/markdown（JSON）。
 */
docs.get('/:id/export/file', (c) => {
  const id = c.req.param('id')
  const file = buildDocExportFile(id)
  if (!file) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }

  return new Response(Buffer.from(file.body), {
    status: 200,
    headers: {
      'Content-Type': file.contentType,
      'Content-Disposition': contentDispositionAttachment(file.filename),
      'Cache-Control': 'no-store',
    },
  })
})

export default docs
