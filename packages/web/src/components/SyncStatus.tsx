import { Loader2, Cloud, AlertCircle } from 'lucide-react'
import { useSyncStatus } from '../hooks/useSyncStatus'
import { Tooltip } from './ui'
import { formatIsoDateTime } from '../lib/time'

/**
 * 文档页同步状态指示（方案 A：多端共享 S3）。
 * 展示：
 * - 未配置同步：不渲染（隐藏）
 * - 同步进行中（running）：转圈 + 「同步中」
 * - 上次失败：警示图标（tooltip 显示错误）
 * - 空闲：低调「已同步 HH:MM」
 */
export default function SyncStatus() {
  const status = useSyncStatus()

  if (!status?.enabled || !status.configured) return null

  if (status.running) {
    return (
      <span className="inline-flex items-center gap-1 text-primary/80">
        <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.75} />
        同步中
      </span>
    )
  }

  if (status.lastError) {
    return (
      <Tooltip label={`上次同步失败：${status.lastError}`}>
        <span className="inline-flex items-center gap-1 text-destructive/80 cursor-help">
          <AlertCircle className="w-3 h-3" strokeWidth={1.75} />
          同步失败
        </span>
      </Tooltip>
    )
  }

  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground/60">
      <Cloud className="w-3 h-3" strokeWidth={1.75} />
      {status.lastSuccessAt ? `已同步 ${formatIsoDateTime(status.lastSuccessAt)}` : '待同步'}
    </span>
  )
}
