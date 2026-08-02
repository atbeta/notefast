import { useNavigate } from 'react-router-dom'
import { Loader2, Cloud, CheckCircle2, AlertCircle } from 'lucide-react'
import { useSyncStatus } from '../hooks/useSyncStatus'
import { Tooltip } from './ui'
import { formatIsoDateTime } from '../lib/time'

/**
 * 全局同步状态胶囊（固定在主区域右上角，各页面常驻）。
 * 展示优先级：同步中 > 同步失败 > 有待同步 > 已同步；点击进入「多端同步」设置。
 */
export default function GlobalSyncStatus() {
  const navigate = useNavigate()
  const status = useSyncStatus()

  // 未配置 / 未启用同步：不打扰用户
  if (!status?.enabled || !status.configured) return null

  let icon: React.ReactNode
  let label: string
  let tooltip: string

  if (status.running) {
    icon = <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" strokeWidth={2} />
    label = '同步中'
    tooltip = '正在同步'
  } else if (status.lastError) {
    icon = <AlertCircle className="w-3.5 h-3.5 text-destructive" strokeWidth={2} />
    label = '同步失败'
    tooltip = `同步失败：${status.lastError}`
  } else if ((status.pendingChanges ?? 0) > 0) {
    icon = <Cloud className="w-3.5 h-3.5 text-amber-500" strokeWidth={2} />
    label = `${status.pendingChanges} 条待同步`
    tooltip = '有变更待同步，稍后自动推送'
  } else {
    icon = <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" strokeWidth={2} />
    label = status.lastSuccessAt ? '已同步' : '待同步'
    tooltip = status.lastSuccessAt ? `已同步 ${formatIsoDateTime(status.lastSuccessAt)}` : '尚未同步'
  }

  return (
    <Tooltip label={tooltip}>
      <button
        type="button"
        onClick={() => navigate('/settings')}
        className="fixed top-3 right-3 z-40 flex items-center gap-1.5 h-7 pl-2 pr-2.5 rounded-full border border-border/60 bg-card/90 backdrop-blur text-[11.5px] text-muted-foreground shadow-sm hover:border-border hover:text-foreground transition-colors"
        aria-label={`同步状态：${label}`}
      >
        {icon}
        <span>{label}</span>
      </button>
    </Tooltip>
  )
}
