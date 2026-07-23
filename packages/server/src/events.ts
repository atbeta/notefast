import type { AppEvent } from '@notefast/core'
import { safeLogInfo, safeLogWarn } from '@notefast/core'

export function emitAppEvent(partial: Omit<AppEvent, 'ts'>): void {
  try {
    const event: AppEvent = {
      ...partial,
      ts: new Date().toISOString(),
    }
    const { ts, source, actor, action, target, outcome, durationMs, error, fields } = event
    const logFn = outcome === 'failure' ? safeLogWarn : safeLogInfo
    logFn(action, { ts, source, actor, target, outcome, durationMs, error, ...(fields ?? {}) })
  } catch {
    /* 日志失败不应影响主流程 */
  }
}
