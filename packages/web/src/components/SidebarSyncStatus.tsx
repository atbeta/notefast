import { Loader2 } from 'lucide-react'
import { useSyncStatus } from '../hooks/useSyncStatus'
import { Tooltip } from './ui'

/**
 * 侧栏底部同步状态点（全局可见，低调）。
 * - 未配置同步：不渲染
 * - 同步中：转圈（tooltip「同步中」）
 * - 失败：红点（tooltip 显示错误）—— 最值得全局提示
 * - 已同步：绿点（tooltip「已同步 HH:MM」）
 * - 待同步（从未同步）：灰点（tooltip「待同步」）
 */
export default function SidebarSyncStatus() {
  const status = useSyncStatus()

  if (!status?.enabled || !status.configured) return null

  if (status.running) {
    return (
      <Tooltip label="同步中">
        <Loader2 className="w-3 h-3 animate-spin text-primary shrink-0" strokeWidth={2} />
      </Tooltip>
    )
  }

  if (status.lastError) {
    return (
      <Tooltip label={`同步失败：${status.lastError}`}>
        <span className="w-2 h-2 rounded-full bg-destructive shrink-0" aria-label="同步失败" />
      </Tooltip>
    )
  }

  const synced = Boolean(status.lastSuccessAt)
  return (
    <Tooltip label={synced ? '已同步' : '待同步'}>
      <span
        className={`w-2 h-2 rounded-full shrink-0 ${synced ? 'bg-emerald-500' : 'bg-sidebar-muted/50'}`}
        aria-label={synced ? '已同步' : '待同步'}
      />
    </Tooltip>
  )
}
