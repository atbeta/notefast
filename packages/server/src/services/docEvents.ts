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
import { getBlockById } from '../store/blocks'
import type { BlockRow } from '@notefast/core'

export type DocChangeKind = 'created' | 'updated' | 'deleted'

export interface DocChangeEvent {
  doc_id: string
  kind: DocChangeKind
  at: string
  /**
   * 本窗口内发生变更的 block id（聚合去重）。
   *
   * 出方向按块局部改写要靠它：只知道「文档变了」就得重新指纹每个顶层块，
   * 文档越大越贵。带上块 id 后可以直接定位被改的块。
   * `undefined` = 调用方不需要该信息（例如 publishDocChange 的显式调用）；
   * 空数组 = 本窗口只改了文档级元数据，没有块内容变化。
   */
  changed_block_ids?: string[]
}

type Listener = (ev: DocChangeEvent) => void

const HOOK_NAME = 'doc-events'
/** block 事件聚合窗口：一次写入的 N 个 block 事件合并为一条 doc 事件 */
export const FLUSH_MS = 300

const listeners = new Set<Listener>()
const pending = new Map<string, DocChangeKind>()
/** 窗口内每个文档被改过的块 id（按文档累积，flush 时随事件带出） */
const pendingBlocks = new Map<string, Set<string>>()
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

/**
 * 记下一个被改动的块，随本窗口的 doc 事件带出。
 *
 * 与 publishDocChange 分开是因为两者来源不同：kind 由显式调用方决定，
 * 块 id 只有 block 级 hooks 才知道。
 */
function trackChangedBlock(docId: string, blockId: string): void {
  let set = pendingBlocks.get(docId)
  if (!set) {
    set = new Set()
    pendingBlocks.set(docId, set)
  }
  set.add(blockId)
}

function flush(): void {
  flushTimer = null
  if (pending.size === 0) return
  const at = new Date().toISOString()
  const batch = [...pending.entries()]
  pending.clear()
  const blockBatch = new Map(pendingBlocks)
  pendingBlocks.clear()
  for (const [doc_id, kind] of batch) {
    // 有块级变更就带出来；没有（纯元数据写入）给空数组而不是 undefined，
    // 让订阅者能区分「没变块」与「调用方没提供这个信息」
    const ev: DocChangeEvent = { doc_id, kind, at, changed_block_ids: [...(blockBatch.get(doc_id) ?? [])] }
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
    const docId = docIdOf(block)
    publishDocChange(docId, block.type === 'document' ? 'created' : 'updated')
    trackChangedBlock(docId, block.id)
  })
  pluginSystem.note.afterUpdate.tap(HOOK_NAME, (block) => {
    const docId = docIdOf(block)
    publishDocChange(docId, 'updated')
    trackChangedBlock(docId, block.id)
  })
  pluginSystem.note.afterDelete.tap(HOOK_NAME, (blockId) => {
    const row = getBlockById(getDb(), blockId)
    if (!row) return // 硬删除或无此块：无法归属文档，跳过
    if (row.type === 'document') {
      publishDocChange(blockId, 'deleted')
      return
    }
    if (row.root_id) {
      publishDocChange(row.root_id, 'updated')
      // 被删的块本身不再参加指纹比对，但它的父块（顶层祖先）需要重写，
      // 因此把顶层祖先一并标出来：局部改写按顶层块为单位
      trackChangedBlock(row.root_id, topLevelAncestorId(row))
    }
  })
  console.log('📡 Doc events broadcaster attached')
}

/** 沿 parent_id 上溯到顶层块（parent 为文档根的那一层） */
function topLevelAncestorId(row: BlockRow): string {
  const db = getDb()
  let current = row
  const seen = new Set<string>([current.id])
  for (;;) {
    if (!current.parent_id || current.parent_id === current.root_id) return current.id
    const parent = getBlockById(db, current.parent_id)
    if (!parent || seen.has(parent.id)) return current.id
    seen.add(parent.id)
    current = parent
  }
}
