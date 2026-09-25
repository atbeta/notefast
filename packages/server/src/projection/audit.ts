/**
 * 投影审计事件。
 *
 * 与 `services/hooks.auditDocAction` 同格式，但**不**触发 `scheduleSyncNow`：
 * 投影的文件变更由 watcher 负责跟进，不需要再叫醒多端同步
 * （那是 SQLite 派生索引的同步协议，与文件夹投影是两回事）。
 */

import { emitAppEvent } from '../events'

export function auditProjection(
  action: string,
  docId: string,
  fields?: Record<string, unknown>,
  outcome: 'success' | 'failure' = 'success',
): void {
  emitAppEvent({
    source: 'system',
    actor: 'projection',
    action,
    target: { type: 'doc', id: docId },
    outcome,
    fields,
  })
}

/** 审计用的动作名（集中在这里，避免各调用点的字符串漂移） */
export const PROJECTION_AUDIT = {
  /** 出方向：按块局部改写成功 */
  writtenPatch: 'doc.projection_written',
  /** 出方向：退回整篇序列化（拿不到区间记录 / 区间校验失败） */
  writtenFull: 'doc.projection_written_full',
  /** 出方向：检测到外部修改，落了冲突副本 */
  conflict: 'doc.projection_writeback_conflict',
  /** 入方向：文件导入 */
  ingested: 'doc.projection_ingested',
  /** 入方向：文件消失，文档进回收站 */
  trashed: 'doc.projection_trashed',
} as const
