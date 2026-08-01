import type { Block, DocumentEventPayload } from '@notefast/core'
import { getPluginSystem } from './aiRuntime'

/**
 * Hook 触发器
 *
 * 设计：fire-and-forget。
 * - 不阻塞 HTTP 响应（embedding / autolink 可能跑数百 ms~几秒）
 * - 内部 tap 各自 catch 错误；这里再兜一层防 unhandled rejection
 * - getPluginSystem() 未初始化（极早期启动场景）静默跳过
 *
 * 若需同步等待副作用（例如测试），直接 `await sys.note.afterX.call(...)`。
 */

function safeFire(promise: Promise<unknown>, label: string): void {
  promise.catch((e) => {
    console.warn(`[hooks] ${label}:`, e instanceof Error ? e.message : e)
  })
}

export function fireAfterCreate(block: Block): void {
  const sys = getPluginSystem()
  if (!sys) return
  safeFire(sys.note.afterCreate.call(block), 'afterCreate')
}

export function fireAfterUpdate(block: Block): void {
  const sys = getPluginSystem()
  if (!sys) return
  safeFire(sys.note.afterUpdate.call(block), 'afterUpdate')
}

export function fireAfterDelete(blockId: string): void {
  const sys = getPluginSystem()
  if (!sys) return
  safeFire(sys.note.afterDelete.call(blockId), 'afterDelete')
}

/**
 * 批量触发 afterDelete（用于 markdown 全量替换等一次删多块的场景）。
 */
export function fireAfterDeleteMany(blockIds: string[]): void {
  if (blockIds.length === 0) return
  const sys = getPluginSystem()
  if (!sys) return
  for (const id of blockIds) {
    safeFire(sys.note.afterDelete.call(id), 'afterDelete')
  }
}

/**
 * 批量触发 afterCreate（用于 import / MCP create_doc 等一次写入多块的场景）。
 * 仍然 fire-and-forget；调用方不等待。
 */
export function fireAfterCreateMany(blocks: Block[]): void {
  if (blocks.length === 0) return
  const sys = getPluginSystem()
  if (!sys) return
  for (const b of blocks) {
    safeFire(sys.note.afterCreate.call(b), 'afterCreate')
  }
}

// ───────────────────── 文档级生命周期触发 ─────────────────────
// 与 note.*（block 粒度）区分：doc.* 是「一个文档一个动作」的扩展挂点，
// 第三方监听归档/分享/标签/删除等文档级语义，无需自行聚合 block 事件。

function fireDoc<K extends keyof import('@notefast/core').PluginSystem['doc']>(
  hook: K,
  payload: DocumentEventPayload,
): void {
  const sys = getPluginSystem()
  if (!sys) return
  const call = sys.doc[hook] as { call: (p: DocumentEventPayload) => Promise<void> }
  safeFire(call.call(payload), `doc.${String(hook)}`)
}

/** 文档创建完成（POST /docs、import 入库、MCP create_doc 等） */
export function fireDocAfterCreate(payload: DocumentEventPayload): void {
  fireDoc('afterCreate', payload)
}

/** 文档状态变更（归档 / 升格 / 进收集箱）；payload.before.status 为旧状态 */
export function fireDocAfterStatusChange(payload: DocumentEventPayload): void {
  fireDoc('afterStatusChange', payload)
}

/** 打标签完成；payload.before.tags 为旧标签，meta 含新增/删除集合 */
export function fireDocAfterTagChange(payload: DocumentEventPayload): void {
  fireDoc('afterTagChange', payload)
}

/** 公开分享开启 */
export function fireDocAfterShare(payload: DocumentEventPayload): void {
  fireDoc('afterShare', payload)
}

/** 公开分享关闭 */
export function fireDocAfterShareRevoked(payload: DocumentEventPayload): void {
  fireDoc('afterShareRevoked', payload)
}

/** 文档软删除完成 */
export function fireDocAfterDelete(payload: DocumentEventPayload): void {
  fireDoc('afterDelete', payload)
}
