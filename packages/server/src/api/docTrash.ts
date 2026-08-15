/**
 * 回收站路由（GET /trash、DELETE /trash、DELETE /:id/permanent）——从 api/docs.ts 拆出。
 *
 * 注册顺序要求：GET/DELETE /trash 必须先于 GET/DELETE /:id 注册
 * （'trash' 会被 :id 吞掉），故整个模块在 docs.ts 的 /:id 路由之前统一注册。
 */

import type { Hono } from 'hono'
import { getDb } from '../db'
import { getDeletedBlockById, fetchDeletedSubtreeIds, hardDeleteBlocks, deleteBlockRevisions, listDeletedDocRows } from '../store/blocks'
import { deleteRefsTouchingBlocks } from '../store/refs'
import { deleteMentionsTouchingBlocks } from '../store/entities'
import { deleteSharesByDocIds } from '../store/shares'
import { auditDocAction } from '../services/hooks'
import { deleteVectorMany } from '../ai/indexer'

/**
 * 永久删除一棵已软删除的文档子树（不可恢复）：
 * 事务内物理清理 blocks 行 + 引用/提及/分享/修订/快照；向量异步清除
 * （vec 后端有 BEFORE DELETE 触发器兜底，JSON 后端靠 deleteVectorMany 显式删）。
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

  // 向量清理：显式批量删除（一次 IN + 一次 count；JSON 后端必须，vec 后端触发器冗余兜底）。
  // 注意：软删除时向量已清，这里大多是 no-op，但绝不能用逐块 deleteVector ——
  // 每块一次全表 count(*) 会让清空回收站退化成 O(总块数 × 总向量数)。
  await deleteVectorMany(allIds)

  return { ok: true, count: allIds.length }
}

export function registerTrashRoutes(docs: Hono): void {
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

    // 批量清空：一次性收集所有文档的全部块，单个大事务 + 一次批量向量删除，
    // 避免「每篇一个事务 + 一次 count(*)」的 N 倍开销。
    const allIds: string[] = []
    const perDoc: Array<{ id: string; count: number }> = []
    for (const r of rows) {
      const subtree = [r.id, ...fetchDeletedSubtreeIds(db, r.id)]
      perDoc.push({ id: r.id, count: subtree.length })
      allIds.push(...subtree)
    }

    if (allIds.length > 0) {
      db.transaction(() => {
        deleteRefsTouchingBlocks(db, allIds)
        deleteMentionsTouchingBlocks(db, allIds)
        // 分享 + 快照按文档根清理
        for (const id of perDoc) {
          deleteSharesByDocIds(db, [id.id])
          db.query('DELETE FROM doc_snapshots WHERE doc_id = ?').run(id.id)
        }
        deleteBlockRevisions(db, allIds)
        hardDeleteBlocks(db, allIds)
      })()
      await deleteVectorMany(allIds)
    }

    for (const d of perDoc) {
      auditDocAction('doc.permanently_deleted', d.id, { block_count: d.count })
    }
    return c.json({ deleted: true, count: allIds.length, docs: rows.length })
  })
}
