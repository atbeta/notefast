/**
 * 投影入方向：文件 → SQLite（RFC 0007 D6）。
 *
 * 与 vault ingest 的关键差别：**库是权威**，这里只做「库吸收文件的变更」，
 * 不做身份配对、不做回声判定、不读 frontmatter 元数据。
 *
 * 三种动作：
 *   - 文件是新的（无映射）→ 建文档（沿用 insertDocFromMarkdown，与导入同一条路径）
 *   - 文件有映射且内容变了 → 按指纹对齐子块（沿用 syncMarkdownChildren，与编辑器整篇保存同一条路径）
 *   - 文件消失了 → 文档进**回收站**（软删除，D9），不是物理删除
 *
 * 不写文件：出方向见 services/shadowMarkdown.ts。
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { getDb } from '../db'
import { rowToBlock, stripDocFrontmatter, stripTitleHeading } from '@notefast/core'
import type { BlockRow } from '@notefast/core'
import {
  fetchDocBlocks,
  fetchRestorableSubtreeIds,
  getBlockById,
  getBlocksByIds,
  getDeletedBlockById,
  getDocById,
  getLiveDocById,
  restoreBlocks,
  softDeleteBlocks,
  updateBlock,
} from '../store/blocks'
import { deleteMentionsTouchingBlocks } from '../store/entities'
import { deleteRefsTouchingBlocks } from '../store/refs'
import {
  deleteProjectionFileByPath,
  findMovedProjectionFile,
  getProjectionFileByDoc,
  getProjectionFileByPath,
  listProjectionFiles,
  moveProjectionFile,
  touchProjectionFileAfterWrite,
  upsertProjectionFile,
} from '../store/projectionFiles'
import { deleteProjectionBlockSpans, listProjectionBlockSpans } from '../store/projectionSpans'
import { scheduleDocIndex } from '../ai/indexJobs'
import { insertDocFromMarkdown } from '../services/docImport'
import { fireAfterCreate, fireAfterCreateMany, fireAfterDeleteMany, fireAfterUpdate, fireDocAfterCreate } from '../services/hooks'
import { syncMarkdownChildren } from '../services/markdownChildSync'
import { parseMarkdownToBlocksForSave } from '../services/markdownParse'
import { recordProjectionSpans } from './spans'
import { readProjectionFile } from './writer'
import { isIgnoredRelPath, isMarkdownPath, titleFromRelPath, toProjectionAbsPath } from './paths'
import type { ProjectionConfig } from './config'
import type { SerialLock } from './lock'

type Db = ReturnType<typeof getDb>

/**
 * 当前磁盘上实际存在的相对路径集合（移动检测用：排除「映射行在、文件也在」的正常情况）。
 * 只读目录，不读内容，代价可接受；出错时返回空集合（宁可少判一次移动，也不误判）。
 */
function onDiskRelPaths(root: string): Set<string> {
  const out = new Set<string>()
  const walk = (dir: string, prefix: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (isIgnoredRelPath(`${rel}/x.md`)) continue
        walk(join(dir, e.name), rel)
      } else if (isMarkdownPath(rel) && !isIgnoredRelPath(rel)) {
        out.add(rel)
      }
    }
  }
  walk(root, '')
  return out
}

export interface ProjectionContext {
  db: Db
  notebookId: string
  config: ProjectionConfig
  /** ingest / reconcile / 写回共用的一把串行锁 */
  lock: SerialLock
}

export type IngestAction = 'created' | 'updated' | 'unchanged' | 'deleted' | 'skipped' | 'moved'

export interface IngestResult {
  relPath: string
  docId: string | null
  action: IngestAction
  inserted: number
  updated: number
  deleted: number
}

function zero(action: IngestAction, relPath: string, docId: string | null = null): IngestResult {
  return { relPath, docId, action, inserted: 0, updated: 0, deleted: 0 }
}

/**
 * 导入（或刷新）一个投影文件。
 *
 * 幂等：内容 sha 未变直接返回 `unchanged`，不解析不对齐。
 * 这条短路同时吞掉「我们自己写回产生的回声」——写回成功后会把新 sha 记进映射表。
 */
export async function ingestProjectionFile(
  ctx: ProjectionContext,
  relPath: string,
): Promise<IngestResult> {
  const { db, notebookId, config } = ctx
  if (!isMarkdownPath(relPath) || isIgnoredRelPath(relPath, config.ignore)) {
    return zero('skipped', relPath)
  }

  const abs = toProjectionAbsPath(config.root, relPath)
  const file = await readProjectionFile(abs)
  if (!file) return removeProjectionFile(ctx, relPath)

  const existing = getProjectionFileByPath(db, notebookId, relPath)
  // 变更短路：内容没变就不用解析。
  // 但**必须**同时确认文档在流通——文件可能刚从「消失」状态回来，
  // 内容一个字节都没变，而文档还躺在回收站里。只看 sha 会把它永远留在那儿
  // （实测踩过：恢复的文件一直不出现在列表里）。
  if (existing && existing.content_sha256 === file.sha256 && getLiveDocById(db, existing.doc_id)) {
    return zero('unchanged', relPath, existing.doc_id)
  }

  const title = titleFromRelPath(relPath)
  const stripped = stripDocFrontmatter(file.content)

  // ── 新路径：可能是移动过来的同一个文档 ─────────────────────────
  // 文件从 A 消失、出现在 B（内容相同）。unlink(A) 时我们保留了映射行，
  // 这里按内容 sha 配对出来，改路径 + 恢复，而不是新建一篇重复文档。
  if (!existing) {
    const moved = findMovedProjectionFile(db, notebookId, file.sha256, onDiskRelPaths(config.root))
    if (moved) {
      const prior = getDocById(db, moved.doc_id)
      if (prior) {
        moveProjectionPath(ctx, moved.rel_path, relPath)
        // 路径换了，文档若在回收站里则恢复；随后按普通更新路径对齐内容
        const rowNow = getProjectionFileByPath(db, notebookId, relPath)!
        const restored = !getLiveDocById(db, moved.doc_id)
        if (restored) {
          const ids = [moved.doc_id, ...fetchRestorableSubtreeIds(db, moved.doc_id)]
          restoreBlocks(db, ids)
          fireAfterCreateMany(getBlocksByIds(db, ids.filter((i) => i !== moved.doc_id)).map(rowToBlock))
        }
        // 内容一致时无需再解析：刷新指纹即可
        if (rowNow.content_sha256 === file.sha256) {
          const docRow = getBlockById(db, moved.doc_id)!
          upsertProjectionFile(db, {
            notebook_id: notebookId,
            rel_path: relPath,
            doc_id: moved.doc_id,
            content_sha256: file.sha256,
            size: file.size,
            mtime_ms: file.mtimeMs,
            doc_updated_at: docRow.updated_at,
          })
          recordProjectionSpans(db, moved.doc_id, { body: stripped.body })
          return { relPath, docId: moved.doc_id, action: 'moved', inserted: 0, updated: 0, deleted: 0 }
        }
        // 路径与内容同时变了：落到下面的更新分支处理
        return ingestProjectionFile(ctx, relPath)
      }
      // 文档已被永久删除：清掉这条陈旧映射，按新文件重建
      deleteProjectionFileByPath(db, notebookId, moved.rel_path)
    }
  }

  // ── 新文件：建文档 ──────────────────────────────────────────────
  // 注意：文件「消失又回来」的情况不会走到这里——映射行在消失时被保留，
  // 所以 `existing` 会命中，走下面的恢复分支（见 removeProjectionFile 注释）。
  if (!existing) {
    const created = insertDocFromMarkdown(db, {
      notebookId,
      title,
      markdown: file.content,
      applyFrontmatterTags: true,
      rejectEmpty: false,
    })
    const docRow = getBlockById(db, created.docId)!
    upsertProjectionFile(db, {
      notebook_id: notebookId,
      rel_path: relPath,
      doc_id: created.docId,
      content_sha256: file.sha256,
      size: file.size,
      mtime_ms: file.mtimeMs,
      doc_updated_at: docRow.updated_at,
    })
    fireAfterCreate(rowToBlock(docRow))
    fireAfterCreateMany(getBlocksByIds(db, created.blockIds).map(rowToBlock))
    fireDocAfterCreate({
      doc: rowToBlock(docRow),
      meta: { status: 'note', tags: [], source: 'projection' },
    })
    scheduleDocIndex(created.docId, created.blockIds)
    recordProjectionSpans(db, created.docId, { body: stripped.body })
    return { relPath, docId: created.docId, action: 'created', inserted: created.blockIds.length, updated: 0, deleted: 0 }
  }

  // ── 既有文件：对齐子块 ──────────────────────────────────────────
  const docId = existing.doc_id
  const before = getDocById(db, docId)
  if (!before) {
    // 映射行指向一个不存在的文档（库侧被永久删除）：清理映射，按新文件重建
    deleteProjectionFileByPath(db, notebookId, relPath)
    deleteProjectionBlockSpans(db, docId)
    return ingestProjectionFile(ctx, relPath)
  }

  // 文档在回收站里：文件还在 = 用户没想删它 → 恢复。
  // 注意 BlockRow 类型没有 is_deleted，必须用 getDeletedBlockById 判定（vault 计划里记过这个坑）
  const restoredIds: string[] = []
  if (getDeletedBlockById(db, docId)) {
    restoredIds.push(docId, ...fetchRestorableSubtreeIds(db, docId))
    restoreBlocks(db, restoredIds)
  }

  const rawInputs = parseMarkdownToBlocksForSave(stripped.body, notebookId)
  const inputs = stripTitleHeading(rawInputs, title)
  const oldChildren = fetchDocBlocks(db, docId).filter((r) => r.id !== docId)

  let insertedIds: string[] = []
  let deletedIds: string[] = []
  let updatedIds: string[] = []
  db.transaction(() => {
    db.run('PRAGMA defer_foreign_keys = ON')
    const docNow = getDocById(db, docId)!
    if (docNow.content !== title) {
      updateBlock(db, docId, { content: title, noRevision: true, actor: 'projection' })
    }
    const sync = syncMarkdownChildren(db, { notebookId, rootId: docId, inputs, oldChildren })
    insertedIds = sync.insertedIds
    deletedIds = sync.deletedIds
    updatedIds = sync.updatedIds
    deleteRefsTouchingBlocks(db, deletedIds)
    deleteMentionsTouchingBlocks(db, deletedIds)
  })()

  const after = getBlockById(db, docId)!
  upsertProjectionFile(db, {
    notebook_id: notebookId,
    rel_path: relPath,
    doc_id: docId,
    content_sha256: file.sha256,
    size: file.size,
    mtime_ms: file.mtimeMs,
    doc_updated_at: after.updated_at,
  })

  fireAfterDeleteMany(deletedIds)
  const reindexIds = [...new Set([...restoredIds.filter((id) => id !== docId), ...insertedIds, ...updatedIds])]
  scheduleDocIndex(docId, reindexIds)
  recordProjectionSpans(db, docId, { body: stripped.body })
  fireAfterCreateMany(getBlocksByIds(db, insertedIds).map(rowToBlock))
  for (const row of getBlocksByIds(db, updatedIds)) fireAfterUpdate(rowToBlock(row))
  fireAfterUpdate(rowToBlock(after))

  return {
    relPath,
    docId,
    action: 'updated',
    inserted: insertedIds.length,
    updated: updatedIds.length,
    deleted: deletedIds.length,
  }
}

/**
 * 文件从文件夹消失 → 文档进回收站（RFC 0007 D9）。
 *
 * **软删除**，不是物理删除：用户在回收站里能恢复，正文与子块都还在。
 * 恢复后出方向会把文件重新写出来。
 *
 * **映射行保留**（不是删掉）。生命周期跟着「投影关系」走，而不是跟着「文件当前在不在」：
 * 文件可能只是被临时移走又移回来（git 切换分支、同步工具中间态、用户拖出去又拖回来），
 * 那时必须认领原来那篇文档，而不是新建一篇。
 * 实测踩过：删掉映射行后，文件回来会走 `created` 分支，库里多出一篇重复文档。
 * 映射行只在文档被**永久删除**时才清（见下方判定）。
 */
export function removeProjectionFile(ctx: ProjectionContext, relPath: string): IngestResult {
  const { db, notebookId } = ctx
  const row = getProjectionFileByPath(db, notebookId, relPath)
  if (!row) return zero('skipped', relPath)

  const doc = getDocById(db, row.doc_id)
  if (!doc) {
    // 文档根本不存在（被永久删除过）：映射与区间一并清理
    deleteProjectionFileByPath(db, notebookId, relPath)
    deleteProjectionBlockSpans(db, row.doc_id)
    return zero('deleted', relPath, row.doc_id)
  }

  if (!getLiveDocById(db, row.doc_id)) {
    // 已经在回收站里：幂等，不重复软删除
    return zero('deleted', relPath, row.doc_id)
  }

  const ids = [row.doc_id, ...fetchRestorableSubtreeIds(db, row.doc_id)]
  softDeleteBlocks(db, ids)
  fireAfterDeleteMany(ids)
  return { relPath, docId: row.doc_id, action: 'deleted', inserted: 0, updated: 0, deleted: ids.length }
}

/**
 * 文件在外部被改名 / 移动：同一文档换路径，不新建文档。
 *
 * 与 vault 的区别：vault 靠 sha 配对猜「这是不是同一次 rename」，因为路径是它的身份；
 * 投影下 doc_id 才是身份，映射表直接跟着走即可——但**仍需**调用方告诉我们是哪篇，
 * 所以这里由 watcher 在「同 sha 的新路径 + 已消失的旧路径」时触发。
 */
export function moveProjectionPath(ctx: ProjectionContext, fromRel: string, toRel: string): void {
  const { db, notebookId } = ctx
  const row = getProjectionFileByPath(db, notebookId, fromRel)
  if (!row) return
  // 目标路径已经被别的文档占了：让旧的让位，避免唯一索引冲突
  const occupied = getProjectionFileByPath(db, notebookId, toRel)
  if (occupied && occupied.doc_id !== row.doc_id) {
    deleteProjectionFileByPath(db, notebookId, toRel)
  }
  moveProjectionFile(db, notebookId, fromRel, toRel)
}

/** 出方向写回成功后同步映射（内容指纹与 doc 时间戳） */
export function syncProjectionFileAfterWrite(
  ctx: Pick<ProjectionContext, 'db' | 'notebookId'>,
  docId: string,
  contentSha256: string,
  size: number,
  mtimeMs: number,
  docUpdatedAt: string,
): void {
  touchProjectionFileAfterWrite(ctx.db, ctx.notebookId, docId, contentSha256, size, mtimeMs, docUpdatedAt)
}

/** 该文档当前是否已有投影映射（出方向据此决定图片落点等） */
export function projectionRelForDoc(db: Db, notebookId: string, docId: string): string | null {
  return getProjectionFileByDoc(db, notebookId, docId)?.rel_path ?? null
}

/** 已建立映射的文档 id 集合（对账用） */
export function mappedDocIds(db: Db, notebookId: string): Set<string> {
  return new Set(listProjectionFiles(db, notebookId).map((r) => r.doc_id))
}

/** 该文档有无区间记录（出方向判断能否局部改写；无则退回整篇） */
export function hasProjectionSpans(db: Db, docId: string): boolean {
  return listProjectionBlockSpans(db, docId).length > 0
}

export type { BlockRow }
