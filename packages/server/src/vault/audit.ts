/**
 * vault 审计事件：与 services/hooks.auditDocAction 同格式，但不触发 scheduleSyncNow
 * （vault 模式下多端同步由文件层负责，RFC 0001 D6）。
 */

import { emitAppEvent } from '../events'

export function auditVault(action: string, docId: string, fields?: Record<string, unknown>): void {
  emitAppEvent({
    source: 'system',
    actor: 'vault',
    action,
    target: { type: 'doc', id: docId },
    outcome: 'success',
    fields,
  })
}
