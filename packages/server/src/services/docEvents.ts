/**
 * 文档级变更事件总线
 *
 * 订阅插件 hooks（block 级），聚合为 doc 级事件后广播给订阅者（SSE 端点）：
 * - 一次写入（建文档 / 整篇保存 / 追加）会产生 N 个 block 事件，
 *   在 FLUSH_MS 窗口内按 docId 合并为一条，避免前端连续 refetch
 * - 同窗口内 kind 升级优先级：deleted > created > updated
 * - afterDelete 只有 blockId：回查 blocks 表（软删除行仍在库中）
 *   区分「整篇删除」（document 块）与「子块删除」（归属 root_id 文档的更新）
 */

import type { Block, PluginSystem } from '@notefast/core'
import { getDb } from '../db'

export type DocChangeKind = 'created' | 'updated' | 'deleted'

export interface DocChangeEvent {
  doc_id: string
  kind: DocChangeKind
  at: string
}

type Listener = (ev: DocChangeEvent) => void

const HOOK_NAME = 'doc-events'
/** block 事件聚合窗口：一次写入的 N 个 block 事件合并为一条 doc 事件 */
export const FLUSH_MS = 300

const listeners = new Set<Listener>()
const pending = new Map<string, DocChangeKind>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

const RANK: Record<DocChangeKind, number> = { updated: 0, created: 1, deleted: 2 }

/** 发布 doc 级变更（窗口内同 docId 合并，kind 取最高优先级） */
export function publishDocChange(docId: string, kind: DocChangeKind): void {
  const prev = pending.get(docId)
  if (!prev || RANK[kind] > RANK[prev]) pending.set(docId, kind)
  if (flushTimer) return
  flushTimer = setTimeout(flush, FLUSH_MS)
  // CLI / 测试场景：未 flush 的定时器不阻止进程退出
  ;(flushTimer as unknown as { unref?: () => void }).unref?.()
}

function flush(): void {
  flushTimer = null
  if (pending.size === 0) return
  const at = new Date().toISOString()
  const batch = [...pending.entries()]
  pending.clear()
  for (const [doc_id, kind] of batch) {
    const ev: DocChangeEvent = { doc_id, kind, at }
    for (const fn of listeners) {
      try {
        fn(ev)
      } catch (e) {
        console.warn('[docEvents] listener error:', e instanceof Error ? e.message : e)
      }
    }
  }
}

/** 订阅 doc 级变更；返回取消订阅函数 */
export function subscribeDocChanges(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function docIdOf(block: Block): string {
  return block.type === 'document' ? block.id : block.root_id
}

/** 把 block 级 hooks 聚合成 doc 级事件广播（服务启动时挂一次） */
export function initDocEvents(pluginSystem: PluginSystem): void {
  pluginSystem.note.afterCreate.tap(HOOK_NAME, (block) => {
    publishDocChange(docIdOf(block), block.type === 'document' ? 'created' : 'updated')
  })
  pluginSystem.note.afterUpdate.tap(HOOK_NAME, (block) => {
    publishDocChange(docIdOf(block), 'updated')
  })
  pluginSystem.note.afterDelete.tap(HOOK_NAME, (blockId) => {
    const row = getDb()
      .query('SELECT type, root_id FROM blocks WHERE id = ?')
      .get(blockId) as { type: string; root_id: string | null } | undefined
    if (!row) return // 硬删除或无此块：无法归属文档，跳过
    if (row.type === 'document') publishDocChange(blockId, 'deleted')
    else if (row.root_id) publishDocChange(row.root_id, 'updated')
  })
  console.log('📡 Doc events broadcaster attached')
}
