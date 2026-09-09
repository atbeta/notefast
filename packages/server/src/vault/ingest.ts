/**
 * vault ingest：文件 → SQLite（RFC 0002 §增量 ingest）
 *
 * 身份模型：
 *   - 文件身份 = vault 相对路径（vault_files.rel_path）
 *   - 文档身份 = 文档根 block id（随机 UUID，落在 vault_files.doc_id）
 *   - 块身份 = 随机 UUID；跨次 ingest 的稳定性由 syncMarkdownChildren 的指纹对齐保证，
 *     与编辑器整篇保存（PUT /docs/:id/markdown）完全同一条代码路径
 *
 * 不做的事：不写文件（写回见 writeback.ts）、不触发多端同步（vault 模式下由文件层负责）。
 */

import type { getDb } from '../db'
import { readTags, rowToBlock, normalizeTagList, readAiExclude, readDocStatus, stripDocFrontmatter, stripTitleHeading } from '@notefast/core'
import type { BlockRow } from '@notefast/core'
import {
  fetchDocBlocks,
  fetchRestorableSubtreeIds,
  fetchSubtreeBlocks,
  getBlockById,
  getBlocksByIds,
  getDeletedBlockById,
  getDocById,
  getLiveBlockById,
  restoreBlocks,
  softDeleteBlocks,
  updateBlock,
} from '../store/blocks'
import { deleteRefsTouchingBlocks, listBacklinks } from '../store/refs'
import { deleteMentionsTouchingBlocks } from '../store/entities'
import { deleteSharesByDocIds } from '../store/shares'
import {
  findDeletedVaultFileBySha,
  getVaultFileByPath,
  listVaultFiles,
  markVaultFileDeleted,
  moveVaultFile,
  upsertVaultFile,
  deleteVaultFileRow,
} from '../store/vaultFiles'
import { deleteVaultBlockSpans } from '../store/vaultSpans'
import { deleteUnresolvedForBlocks, insertUnresolvedLinks } from '../store/vaultLinks'
import { insertDocFromMarkdown } from '../services/docImport'
import { syncMarkdownChildren } from '../services/markdownChildSync'
import { parseMarkdownToBlocksForSave } from '../services/markdownParse'
import { auditVault } from './audit'
import {
  fireAfterCreate,
  fireAfterCreateMany,
  fireAfterDeleteMany,
  fireAfterUpdate,
  fireDocAfterCreate,
  fireDocAfterDelete,
  fireDocAfterStatusChange,
} from '../services/hooks'
import { scheduleDocIndex } from '../ai/indexJobs'
import { deleteVectorMany } from '../ai/indexer'
import { applyAiExcludeChange, writeDocAiExclude } from '../ai/aiExclude'
import { readVaultFile } from './writer'
import { desiredStatusFromFile, vaultMetaHash } from './meta'
import { recordVaultSpans } from './spans'
import { resolveUnresolvedForDoc, syncVaultWikilinks, wikilinkNamesForPath } from './wikilinks'
import { isIgnoredRelPath, isMarkdownPath, titleFromRelPath, toVaultAbsPath, toVaultRelPath } from './paths'
import type { VaultConfig } from './config'
import type { SerialLock } from './lock'
import { statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

type Db = ReturnType<typeof getDb>

export interface VaultContext {
  db: Db
  notebookId: string
  config: VaultConfig
  /** 所有 vault 写路径（ingest / reconcile / writeback）共用的串行锁 */
  lock: SerialLock
}

export type IngestAction =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'restored'
  | 'moved'
  | 'deleted'
  | 'skipped'
  | 'missing'

export interface IngestResult {
  relPath: string
  docId: string | null
  action: IngestAction
  /** 子块对齐统计（created/unchanged/skipped 时为 0） */
  kept: number
  inserted: number
  updated: number
  deleted: number
}

function zeroStats(): Pick<IngestResult, 'kept' | 'inserted' | 'updated' | 'deleted'> {
  return { kept: 0, inserted: 0, updated: 0, deleted: 0 }
}

interface DocState {
  row: BlockRow
  /** 在回收站（软删除） */
  deleted: boolean
}

/** 文档是否仍在库中（含回收站）；BlockRow 类型不带 is_deleted，用两条查询显式区分 */
function docRowAny(db: Db, docId: string): DocState | null {
  const live = getLiveBlockById(db, docId)
  if (live) return { row: live, deleted: false }
  const gone = getDeletedBlockById(db, docId)
  return gone ? { row: gone, deleted: true } : null
}

/**
 * 把文件里声明的 NoteFast 元数据（`notefast_ai_exclude` / `notefast_status`）落到文档。
 *
 * 必须在 ingest 的 `db.transaction()` **提交之后**调用：ai_exclude 变更要动向量库、
 * status 变更要发文档级钩子，都不是事务内的纯 SQL（见计划「待议」）。
 * 返回是否改动过文档行（调用方据此重取 row，再算 meta_hash）。
 */
async function applyFileMetaToDoc(
  ctx: VaultContext,
  doc: BlockRow,
  fromFile: { aiExclude?: boolean; status?: 'inbox' | 'note' },
): Promise<boolean> {
  const { db } = ctx
  let changed = false

  const oldStatus = readDocStatus(doc)
  const wantStatus = desiredStatusFromFile(fromFile.status, oldStatus)
  if (wantStatus !== oldStatus) {
    updateBlock(db, doc.id, { status: wantStatus, actor: 'vault' })
    fireDocAfterStatusChange({
      doc: rowToBlock(getBlockById(db, doc.id)!),
      before: { status: oldStatus },
      meta: { status: wantStatus, source: 'vault' },
    })
    changed = true
  }

  const oldExclude = readAiExclude(doc)
  const wantExclude = fromFile.aiExclude === true
  if (wantExclude !== oldExclude) {
    writeDocAiExclude(doc.id, wantExclude)
    await applyAiExcludeChange(doc.id, oldExclude, wantExclude)
    changed = true
  }
  return changed
}

// ───────────────────── 单文件 ingest ─────────────────────

export async function ingestVaultFile(ctx: VaultContext, pathInput: string): Promise<IngestResult> {
  const relPath = toVaultRelPath(ctx.config.root, pathInput)
  if (!isMarkdownPath(relPath) || isIgnoredRelPath(relPath, ctx.config.ignore)) {
    return { relPath, docId: null, action: 'skipped', ...zeroStats() }
  }

  const file = await readVaultFile(toVaultAbsPath(ctx.config.root, relPath))
  if (!file) {
    const removed = removeVaultFile(ctx, relPath)
    return { ...removed, action: removed.action === 'deleted' ? 'missing' : removed.action }
  }

  const { db, notebookId } = ctx
  const existing = getVaultFileByPath(db, notebookId, relPath)

  // 短路：内容未变（编辑器无实质写入 / 我们自己写回的回声）
  if (existing && !existing.deleted_at && existing.content_sha256 === file.sha256) {
    const doc = docRowAny(db, existing.doc_id)
    if (doc && !doc.deleted) {
      return { relPath, docId: existing.doc_id, action: 'unchanged', ...zeroStats() }
    }
  }

  // 定位目标文档：同路径映射 → 同 sha 的已删除映射（rename / 重现）→ 新建
  let target: DocState | null = null
  let action: IngestAction = 'updated'

  if (existing) {
    const doc = docRowAny(db, existing.doc_id)
    if (doc) {
      target = doc
      if (existing.deleted_at || doc.deleted) action = 'restored'
    } else {
      deleteVaultFileRow(db, notebookId, relPath)
    }
  } else {
    const paired = findDeletedVaultFileBySha(db, notebookId, file.sha256)
    if (paired) {
      const doc = docRowAny(db, paired.doc_id)
      if (doc) {
        moveVaultFile(db, notebookId, paired.rel_path, relPath)
        target = doc
        action = 'moved'
      } else {
        deleteVaultFileRow(db, notebookId, paired.rel_path)
      }
    }
  }

  const title = titleFromRelPath(relPath)
  const stripped = stripDocFrontmatter(file.content)
  const fmTags = stripped.meta?.tags?.length ? normalizeTagList(stripped.meta.tags) : []
  // 文件是权威：声明的 NoteFast 元数据（RFC 0001 D8）
  const fmAiExclude = stripped.meta?.notefast_ai_exclude
  const fmStatus = stripped.meta?.notefast_status

  if (!target) {
    const created = insertDocFromMarkdown(db, {
      notebookId,
      title,
      markdown: file.content,
      status: fmStatus === 'inbox' ? 'inbox' : 'note',
      applyFrontmatterTags: true,
      rejectEmpty: false,
    })
    let docRow = getBlockById(db, created.docId)!
    // 新建文档此刻还没有向量：直接写列，无需走 applyAiExcludeChange 的 purge
    if (fmAiExclude === true) {
      writeDocAiExclude(created.docId, true)
      docRow = getBlockById(db, created.docId)!
    }
    upsertVaultFile(db, {
      notebook_id: notebookId,
      rel_path: relPath,
      doc_id: created.docId,
      content_sha256: file.sha256,
      size: file.size,
      mtime_ms: file.mtimeMs,
      doc_updated_at: docRow.updated_at,
      frontmatter_raw: stripped.raw,
      meta_hash: vaultMetaHash(docRow),
    })
    fireAfterCreate(rowToBlock(docRow))
    fireAfterCreateMany(getBlocksByIds(db, created.blockIds).map(rowToBlock))
    fireDocAfterCreate({
      doc: rowToBlock(docRow),
      meta: { status: readDocStatus(docRow), tags: readTags(docRow), source: 'vault' },
    })
    scheduleDocIndex(created.docId, created.blockIds)
    // 记录顶层块区间，供后续按块局部写回（解析结果与入库块对不上时自动清空 → 退回整篇）
    recordVaultSpans(db, created.docId, { body: stripped.body })
    // 新文件可能正是别人 `[[引用的名字]]`：先建自己的引用，再补建指向自己的未解析引用
    syncVaultWikilinks(ctx, { touchedBlockIds: created.blockIds })
    resolveUnresolvedForDoc(ctx, created.docId)
    auditVault('doc.vault_ingested', created.docId, { rel_path: relPath, block_count: created.blockIds.length })
    return { relPath, docId: created.docId, action: 'created', kept: 0, inserted: created.blockIds.length, updated: 0, deleted: 0 }
  }

  // 既有文档：必要时先从回收站恢复，再按指纹对齐子块
  const docId = target.row.id
  const restoredIds: string[] = []
  if (target.deleted) {
    restoredIds.push(docId, ...fetchRestorableSubtreeIds(db, docId))
    restoreBlocks(db, restoredIds)
  }

  const rawInputs = parseMarkdownToBlocksForSave(stripped.body, notebookId)
  const inputs = stripTitleHeading(rawInputs, title)
  const oldChildren = fetchDocBlocks(db, docId).filter((r) => r.id !== docId)
  const docBefore = getDocById(db, docId)!
  const oldTags = readTags(docBefore)
  const tagsChanged = fmTags.length > 0 && JSON.stringify(oldTags) !== JSON.stringify(fmTags)

  let insertedIds: string[] = []
  let deletedIds: string[] = []
  let updatedIds: string[] = []
  db.transaction(() => {
    db.run('PRAGMA defer_foreign_keys = ON')
    if (docBefore.content !== title) {
      updateBlock(db, docId, { content: title, noRevision: true, actor: 'vault' })
    }
    if (tagsChanged) {
      updateBlock(db, docId, { tags: JSON.stringify(fmTags), touchUpdatedAt: false, actor: 'vault' })
    }
    const sync = syncMarkdownChildren(db, { notebookId, rootId: docId, inputs, oldChildren })
    insertedIds = sync.insertedIds
    deletedIds = sync.deletedIds
    updatedIds = sync.updatedIds
    deleteRefsTouchingBlocks(db, deletedIds)
    deleteMentionsTouchingBlocks(db, deletedIds)
  })()

  let docAfter = getBlockById(db, docId)!
  // 文件声明的 ai_exclude / status：事务提交后应用（向量与钩子副作用不能进事务）
  await applyFileMetaToDoc(ctx, docAfter, { aiExclude: fmAiExclude, status: fmStatus })
  docAfter = getBlockById(db, docId)!
  upsertVaultFile(db, {
    notebook_id: notebookId,
    rel_path: relPath,
    doc_id: docId,
    content_sha256: file.sha256,
    size: file.size,
    mtime_ms: file.mtimeMs,
    doc_updated_at: docAfter.updated_at,
    frontmatter_raw: stripped.raw,
    meta_hash: vaultMetaHash(docAfter),
  })

  fireAfterDeleteMany(deletedIds)
  const reindexIds = [...new Set([...restoredIds.filter((id) => id !== docId), ...insertedIds, ...updatedIds])]
  scheduleDocIndex(docId, reindexIds)
  // 顶层块区间随本次 ingest 整表重写（写回的字节保真基线）
  recordVaultSpans(db, docId, { body: stripped.body })
  // wikilink：改动块重建引用，删除块清理；再看有没有指向本文件的未解析引用可以补上
  syncVaultWikilinks(ctx, { touchedBlockIds: [...insertedIds, ...updatedIds], deletedBlockIds: deletedIds })
  resolveUnresolvedForDoc(ctx, docId)
  fireAfterCreateMany(getBlocksByIds(db, insertedIds).map(rowToBlock))
  for (const row of getBlocksByIds(db, updatedIds)) fireAfterUpdate(rowToBlock(row))
  fireAfterUpdate(rowToBlock(docAfter))
  auditVault('doc.vault_ingested', docId, {
    rel_path: relPath,
    action,
    inserted: insertedIds.length,
    updated: updatedIds.length,
    deleted: deletedIds.length,
  })

  const kept = oldChildren.length - deletedIds.length
  return { relPath, docId, action, kept: Math.max(0, kept), inserted: insertedIds.length, updated: updatedIds.length, deleted: deletedIds.length }
}

// ───────────────────── 删除 / 移动 ─────────────────────

/**
 * 文件从 vault 消失：文档进回收站（软删除，可恢复），映射行打 deleted_at。
 * 不物理删除：同 sha 文件再出现时按 rename / 重现恢复，回收站清空才真正丢失。
 */
export function removeVaultFile(ctx: VaultContext, pathInput: string): IngestResult {
  const relPath = toVaultRelPath(ctx.config.root, pathInput)
  const { db, notebookId } = ctx
  const row = getVaultFileByPath(db, notebookId, relPath)
  if (!row || row.deleted_at) {
    return { relPath, docId: row?.doc_id ?? null, action: 'skipped', ...zeroStats() }
  }
  const state = docRowAny(db, row.doc_id)
  if (!state) {
    deleteVaultFileRow(db, notebookId, relPath)
    return { relPath, docId: null, action: 'skipped', ...zeroStats() }
  }
  const doc = state.row
  if (state.deleted) {
    markVaultFileDeleted(db, notebookId, relPath)
    return { relPath, docId: doc.id, action: 'deleted', ...zeroStats() }
  }

  const allIds = [doc.id, ...fetchSubtreeBlocks(db, doc.id).map((r) => r.id)]
  // 删 ref 会让反链消失：先把「谁引用过这个文件名」记进 unresolved，
  // 文件同路径重现（回收站恢复）时 resolveUnresolvedForDoc 会把引用补回来
  const incoming = listBacklinks(db, doc.id)
  if (incoming.length > 0) {
    const names = wikilinkNamesForPath(relPath)
    const canonical = names[1] ?? names[0]!
    insertUnresolvedLinks(
      db,
      notebookId,
      [...new Set(incoming.map((r) => r.source_id))].map((sourceId) => ({
        source_block_id: sourceId,
        target_name: canonical,
        anchor: '',
      })),
    )
  }
  db.transaction(() => {
    deleteRefsTouchingBlocks(db, allIds)
    deleteMentionsTouchingBlocks(db, allIds)
    softDeleteBlocks(db, allIds)
    deleteSharesByDocIds(db, [doc.id])
    markVaultFileDeleted(db, notebookId, relPath)
  })()
  void deleteVectorMany(allIds)
  deleteVaultBlockSpans(db, doc.id)
  deleteUnresolvedForBlocks(db, allIds)
  fireAfterDeleteMany(allIds)
  fireDocAfterDelete({ doc: rowToBlock(doc) })
  auditVault('doc.deleted', doc.id, { block_count: allIds.length, rel_path: relPath })
  return { relPath, docId: doc.id, action: 'deleted', kept: 0, inserted: 0, updated: 0, deleted: allIds.length }
}

/**
 * 纯移动：内容未变、只换路径。文档 id / 块 id / 引用 / 向量全部保留，只改映射行 + 标题。
 * watcher 在 unlink+add 配对成功时调用；配对失败才退化为 remove + ingest。
 */
export function moveVaultFilePath(ctx: VaultContext, fromInput: string, toInput: string): IngestResult {
  const from = toVaultRelPath(ctx.config.root, fromInput)
  const to = toVaultRelPath(ctx.config.root, toInput)
  const { db, notebookId } = ctx
  const row = getVaultFileByPath(db, notebookId, from)
  if (!row) return { relPath: to, docId: null, action: 'skipped', ...zeroStats() }
  const state = docRowAny(db, row.doc_id)
  if (!state) {
    deleteVaultFileRow(db, notebookId, from)
    return { relPath: to, docId: null, action: 'skipped', ...zeroStats() }
  }
  const doc = state.row
  const title = titleFromRelPath(to)
  db.transaction(() => {
    moveVaultFile(db, notebookId, from, to)
    if (doc.content !== title) updateBlock(db, doc.id, { content: title, noRevision: true, actor: 'vault' })
  })()
  const after = getBlockById(db, doc.id)!
  upsertVaultFile(db, {
    notebook_id: notebookId,
    rel_path: to,
    doc_id: doc.id,
    content_sha256: row.content_sha256,
    size: row.size,
    mtime_ms: row.mtime_ms,
    doc_updated_at: after.updated_at,
    frontmatter_raw: row.frontmatter_raw,
    // 原样沿用旧指纹：移动不改变元数据，若用当前值重算会把「尚未写回文件」的元数据变更抹掉
    meta_hash: row.meta_hash,
  })
  if (doc.content !== title) fireAfterUpdate(rowToBlock(after))
  // 改名后别人 `[[新名字]]` 的未解析引用可能可以补上了
  resolveUnresolvedForDoc(ctx, doc.id)
  auditVault('doc.vault_moved', doc.id, { from, to })
  return { relPath: to, docId: doc.id, action: 'moved', ...zeroStats() }
}

// ───────────────────── 全量对账 ─────────────────────

export interface ReconcileStats {
  totalFiles: number
  created: number
  updated: number
  unchanged: number
  restored: number
  moved: number
  deleted: number
  /** 轻量模式：size + mtime 与映射行一致、直接跳过未读盘的文件数 */
  stat_skipped: number
  errors: Array<{ relPath: string; error: string }>
  durationMs: number
}

export interface ReconcileOptions {
  /**
   * 轻量模式（定时兜底，V-404）：已知文件先比 size + mtime_ms，一致就不读盘；
   * 新增 / 变更 / 消失的文件照常处理，因此漏事件、休眠唤醒都能追平。
   */
  light?: boolean
}

/** 递归列出 vault 内全部 .md 相对路径（跳过忽略目录与符号链接） */
export async function listVaultMarkdownFiles(config: VaultConfig): Promise<string[]> {
  const out: string[] = []
  const walk = async (absDir: string, relDir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (isIgnoredRelPath(rel, config.ignore)) continue
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walk(join(absDir, entry.name), rel)
      } else if (entry.isFile() && isMarkdownPath(rel)) {
        out.push(rel)
      }
    }
  }
  await walk(config.root, '')
  return out.sort()
}

/**
 * 启动 / 手动重建：让 SQLite 与磁盘对齐。
 * 1. 磁盘上有、映射里没有 或 sha 变了 → ingest（新建 / 更新）
 * 2. 映射里有、磁盘上没有 → 先按 sha 与「新文件」配对成 move，配不上的进回收站
 */
export async function reconcileVault(ctx: VaultContext, opts: ReconcileOptions = {}): Promise<ReconcileStats> {
  const start = Date.now()
  const light = opts.light === true
  const stats: ReconcileStats = {
    totalFiles: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    restored: 0,
    moved: 0,
    stat_skipped: 0,
    deleted: 0,
    errors: [],
    durationMs: 0,
  }
  const onDisk = await listVaultMarkdownFiles(ctx.config)
  stats.totalFiles = onDisk.length
  const diskSet = new Set(onDisk)
  const liveRows = listVaultFiles(ctx.db, ctx.notebookId)
  const missingRows = liveRows.filter((r) => !diskSet.has(r.rel_path))

  // rename 配对：消失的映射 × 无映射的新文件，sha 相同即为移动
  if (missingRows.length > 0) {
    const knownPaths = new Set(liveRows.map((r) => r.rel_path))
    const newFiles = onDisk.filter((p) => !knownPaths.has(p))
    const shaToNew = new Map<string, string[]>()
    for (const rel of newFiles) {
      const f = await readVaultFile(toVaultAbsPath(ctx.config.root, rel))
      if (!f) continue
      const list = shaToNew.get(f.sha256) ?? []
      list.push(rel)
      shaToNew.set(f.sha256, list)
    }
    for (const row of missingRows) {
      const candidates = shaToNew.get(row.content_sha256)
      const to = candidates?.shift()
      if (to) {
        try {
          moveVaultFilePath(ctx, row.rel_path, to)
          stats.moved++
        } catch (e) {
          stats.errors.push({ relPath: row.rel_path, error: e instanceof Error ? e.message : String(e) })
        }
      } else {
        try {
          const r = removeVaultFile(ctx, row.rel_path)
          if (r.action === 'deleted') stats.deleted++
        } catch (e) {
          stats.errors.push({ relPath: row.rel_path, error: e instanceof Error ? e.message : String(e) })
        }
      }
    }
  }

  const liveByPath = new Map(liveRows.map((r) => [r.rel_path, r]))
  for (const rel of onDisk) {
    try {
      // 轻量模式：先比 stat，未变的文件不读盘（sha 短路只能省解析，省不掉读）
      if (light) {
        const row = liveByPath.get(rel)
        if (row) {
          const abs = toVaultAbsPath(ctx.config.root, rel)
          const st = statSync(abs, { throwIfNoEntry: false })
          if (st && st.size === row.size && Math.round(st.mtimeMs) === row.mtime_ms) {
            stats.stat_skipped++
            continue
          }
        }
      }
      const r = await ingestVaultFile(ctx, rel)
      switch (r.action) {
        case 'created':
          stats.created++
          break
        case 'updated':
          stats.updated++
          break
        case 'unchanged':
          stats.unchanged++
          break
        case 'restored':
          stats.restored++
          break
        case 'moved':
          stats.moved++
          break
        default:
          break
      }
    } catch (e) {
      stats.errors.push({ relPath: rel, error: e instanceof Error ? e.message : String(e) })
    }
  }

  stats.durationMs = Date.now() - start
  return stats
}
