import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { createDocSchema, buildBlockTree, buildHeadingTree, blocksToMarkdown, parseMarkdownToBlocks, stripTitleHeading, updateDocMarkdownSchema, updateDocStatusSchema, rowToBlock, readTags, readAiExclude, readDocStatus, isDocInbox, isDocArchived, getTagProvider, parseTagsQueryParam, parseTagMatchMode, parseUpdatedWithin, parseDocStatusFilter, docMatchesTags, parseCreatedWithin, parseStaleWithin } from '@notefast/core'
import type { DocSummary } from '@notefast/core'
import { getDb } from '../db'
import {
  fetchDocBlocks,
  fetchSubtreeBlocks,
  fetchDeletedSubtreeIds,
  getBlockById,
  getDocById,
  getLiveDocById,
  getDeletedBlockById,
  getBlocksByIds,
  listDocRows,
  updateBlock,
  softDeleteBlocks,
  hardDeleteBlocks,
  deleteBlockRevisions,
  listDocRevisions,
  recordDocSnapshot,
  getDocSnapshot,
  nowTimestamp,
  listDeletedDocRows,
} from '../store/blocks'
import { deleteRefsTouchingBlocks } from '../store/refs'
import { deleteMentionsTouchingBlocks } from '../store/entities'
import { getShareByDocId, createShare, deleteShare, setShareExpiry, deleteSharesByDocIds, listSharedDocIds } from '../store/shares'
import { insertDocFromMarkdown, insertChildBlocks, normalizeDocTags } from '../services/docImport'
import { fireAfterCreate, fireAfterUpdate, fireAfterDelete, fireAfterCreateMany, fireAfterDeleteMany, fireDocAfterCreate, fireDocAfterStatusChange, fireDocAfterTagChange, fireDocAfterShare, fireDocAfterShareRevoked, fireDocAfterDelete } from '../services/hooks'
import { extractAssetRefs, findMissingAssets } from '../assets/store'
import { writeDocAiExclude, applyAiExcludeChange } from '../ai/aiExclude'
import { readDocAiExclude } from '../ai/aiExcludeQuery'
import { reanalyzeDoc } from '../ai/autoLink'
import { deleteVector } from '../ai/indexer'
import { scheduleDocIndex } from '../ai/indexJobs'
import { buildDocExportFile, contentDispositionAttachment } from '../services/docExport'
import { listRelatedDocs } from '../services/docRelated'
import { emitAppEvent } from '../events'
import { scheduleSyncNow } from '../sync/protocolManager'

const docs = new Hono()

/** 文档级操作审计（写路径统一出口）：记录谁在何时对哪个文档做了什么 */
function auditDocAction(
  action: string,
  docId: string,
  fields?: Record<string, unknown>,
): void {
  emitAppEvent({
    source: 'web',
    actor: 'admin',
    action,
    target: { type: 'doc', id: docId },
    outcome: 'success',
    fields,
  })
  // 文档写入后去抖自动同步（fire-and-forget，未配置同步时静默跳过）
  scheduleSyncNow()
}

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
docs.get('/trash', (c) => {
  const db = getDb()
  return c.json(
    listDeletedDocRows(db).map((r) => ({
      id: r.id,
      title: r.content,
      deleted_at: r.updated_at,
    })),
  )
})

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

  updateBlock(db, id, { status })

  // 归档 = 退出活跃流通：与删除保持一致，级联关闭公开分享（旧链接立即 404）。
  // 恢复为 note 不复活旧链接，需重新开启（与删除路径语义一致）
  let shareRevoked = false
  if (status === 'archived') {
    shareRevoked = deleteShare(db, id)
  }

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
  // autoIndex 关闭或 embedding 未配时 scheduleDocIndex 返回 null，无需特判）
  scheduleDocIndex(id, fetchDocBlocks(db, id).map((r) => r.id))

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

// ───────────────────── 分享（公开只读链接）─────────────────────
// 独立 shares 表：开关不触发 updated_at / hooks / 索引 / change feed。
// 允许分享 inbox / archived 文档（显式用户行为覆盖默认过滤）；
// ai_exclude 文档也可分享，但首次开启需 confirm_ai_exclude 显式确认（见下）。
// 有效期：默认永不过期（Notion 同款），可选 1/7/30 天；过期 = 未分享（惰性清理）。

const sharePutSchema = z.object({
  expires_in_days: z.union([z.literal(1), z.literal(7), z.literal(30)]).nullish(),
  /** 对 ai_exclude 文档首次开启分享时的显式确认（防误触外泄） */
  confirm_ai_exclude: z.boolean().optional(),
})

docs.get('/:id/share', (c) => {
  const db = getDb()
  const id = c.req.param('id')

  if (!getLiveDocById(db, id)) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }

  const share = getShareByDocId(db, id)
  return c.json(share
    ? {
        shared: true,
        token: share.token,
        path: `/s/${share.token}`,
        created_at: share.created_at,
        expires_at: share.expires_at,
      }
    : { shared: false })
})

docs.put('/:id/share', async (c) => {
  const db = getDb()
  const id = c.req.param('id')

  if (!getLiveDocById(db, id)) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }

  // body 可选（空 body = {}）；仅 expires_in_days 一个字段，手工校验
  const rawBody = await c.req.json().catch(() => ({}))
  const parsed = sharePutSchema.safeParse(rawBody)
  if (!parsed.success) {
    return c.json({ error: 'bad_request', message: 'expires_in_days 只接受 1 / 7 / 30 / null' }, 400)
  }

  const expiryDays = parsed.data.expires_in_days

  // Guardrail：对 ai_exclude 文档首次开启公开分享需要显式确认。
  // 「对 AI 隐藏」不等于「不能分享」（显式用户行为仍可覆盖），但公开链接
  // 对任何持有者裸读全文、默认永不过期，误触代价高，所以服务端强制二次确认。
  // 已开启的 PUT（仅调整有效期，无新增暴露面）不重复要求确认。
  if (
    parsed.data.confirm_ai_exclude !== true &&
    !getShareByDocId(db, id) &&
    readDocAiExclude(id) === true
  ) {
    return c.json({
      error: 'ai_exclude_share_needs_confirm',
      message: '该文档已标记「对 AI 隐藏」。开启公开分享后，任何拿到链接的人无需登录即可阅读全文；确认仍要分享请带 confirm_ai_exclude: true 重试',
    }, 409)
  }

  // 幂等：已开启返回现有 token；带 expires_in_days 时以现在为起点调整有效期。
  // 事务包裹：开启 + 调有效期两步写入对并发 PUT 原子（createShare 内部 ON CONFLICT 兜底）
  const share = db.transaction(() => {
    const created = createShare(db, id)
    return expiryDays !== undefined ? setShareExpiry(db, id, expiryDays)! : created
  })()
  const docRow2 = getLiveDocById(db, id)
  if (docRow2) {
    fireDocAfterShare({
      doc: rowToBlock(docRow2),
      meta: { token: share.token, path: `/s/${share.token}`, expires_at: share.expires_at },
    })
  }
  auditDocAction('doc.shared', id, { token: share.token, expires_at: share.expires_at })
  return c.json({
    token: share.token,
    path: `/s/${share.token}`,
    created_at: share.created_at,
    expires_at: share.expires_at,
  })
})

docs.delete('/:id/share', (c) => {
  const db = getDb()
  const id = c.req.param('id')

  if (!getLiveDocById(db, id)) {
    return c.json({ error: 'not_found', message: `文档 ${id} 不存在` }, 404)
  }

  // 幂等：本就没开启也返回成功；关闭后旧链接立即 404，重开生成全新 token
  const existing = getShareByDocId(db, id)
  deleteShare(db, id)
  const docRow3 = getLiveDocById(db, id)
  if (docRow3 && existing) {
    fireDocAfterShareRevoked({
      doc: rowToBlock(docRow3),
      meta: { token: existing.token },
    })
  }
  if (existing) {
    auditDocAction('doc.share_revoked', id, { token: existing.token })
  }
  return c.json({ deleted: true })
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

/**
 * 永久删除一棵已软删除的文档子树（不可恢复）：
 * 事务内物理清理 blocks 行 + 引用/提及/分享/修订/快照；向量异步清除
 * （vec 后端有 BEFORE DELETE 触发器兜底，JSON 后端靠 deleteVector 显式删）。
 * 仅允许删除回收站中的文档（is_deleted = 1），活文档须先走软删除。
 */
async function purgeDeletedDoc(
  db: ReturnType<typeof getDb>,
  id: string,
): Promise<{ ok: true; count: number } | { ok: false; error: 'not_found' }> {
  const existing = getDeletedBlockById(db, id)
  if (!existing) return { ok: false, error: 'not_found' }

  const allIds = [id, ...fetchDeletedSubtreeIds(db, id)]

  db.transaction(() => {
    deleteRefsTouchingBlocks(db, allIds)
    deleteMentionsTouchingBlocks(db, allIds)
    if (existing.type === 'document') {
      // 分享记录随文档根删除（恢复不复活旧 token，与软删除语义一致）
      deleteSharesByDocIds(db, [id])
      db.query('DELETE FROM doc_snapshots WHERE doc_id = ?').run(id)
    }
    deleteBlockRevisions(db, allIds)
    hardDeleteBlocks(db, allIds)
  })()

  // 向量清理：显式删除（JSON 后端必须；vec 后端触发器为冗余兜底）
  await Promise.all(allIds.map((bid) => deleteVector(bid).catch(() => {})))

  return { ok: true, count: allIds.length }
}

/** 永久删除回收站中的单个文档（不可恢复；活文档须先软删除再进回收站） */
docs.delete('/:id/permanent', async (c) => {
  const db = getDb()
  const id = c.req.param('id')

  const res = await purgeDeletedDoc(db, id)
  if (!res.ok) {
    return c.json({ error: 'not_found', message: `回收站中没有文档 ${id}` }, 404)
  }
  auditDocAction('doc.permanently_deleted', id, { block_count: res.count })
  return c.json({ deleted: true, count: res.count })
})

/** 清空回收站：永久删除全部软删除文档（逐篇调用同一清理路径） */
docs.delete('/trash', async (c) => {
  const db = getDb()
  const rows = listDeletedDocRows(db)

  let total = 0
  for (const r of rows) {
    const res = await purgeDeletedDoc(db, r.id)
    if (res.ok) {
      total += res.count
      auditDocAction('doc.permanently_deleted', r.id, { block_count: res.count })
    }
  }
  return c.json({ deleted: true, count: total, docs: rows.length })
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

  fireAfterDelete(id)
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
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 100)))
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
