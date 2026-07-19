import type { Block } from '@notefast/core'
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
