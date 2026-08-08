import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Loader2, Cloud, CheckCircle2, AlertCircle } from 'lucide-react'
import { useSyncStatus } from '../hooks/useSyncStatus'
import { useDocRailCollapsed } from '../hooks/useDocRailCollapsed'
import { Tooltip } from './ui'
import { formatIsoDateTime } from '../lib/time'

/**
 * 全局同步状态胶囊（固定在窗口右下角，类比未来客户端的底部状态栏）。
 * 展示优先级：同步中 > 同步失败 > 有待同步 > 已同步；点击进入「备份与同步」设置。
 *
 * 位置：文档页右侧有 rail（大纲/实体/历史），lg 屏让出 rail 宽 + 边距，锚到主栏右下；
 * rail 收起为 w-9 / 展开为 w-72；非文档页贴窗口右下角。
 */
export default function GlobalSyncStatus() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const status = useSyncStatus()
  const railCollapsed = useDocRailCollapsed()

  // 未配置 / 未启用同步：不打扰用户
  if (!status?.enabled || !status.configured) return null

  let icon: React.ReactNode
  let label: string
  let tooltip: string

  if (status.running) {
    icon = <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" strokeWidth={2} />
    label = t('syncStatus.syncing')
    tooltip = t('syncStatus.syncingTooltip')
  } else if (status.lastError) {
    icon = <AlertCircle className="w-3.5 h-3.5 text-destructive" strokeWidth={2} />
    label = t('syncStatus.syncFailed')
    tooltip = t('syncStatus.syncFailedWithError', { error: status.lastError })
  } else if ((status.pendingChanges ?? 0) > 0) {
    icon = <Cloud className="w-3.5 h-3.5 text-amber-500" strokeWidth={2} />
    label = t('syncStatus.pendingChanges', { n: status.pendingChanges })
    tooltip = t('syncStatus.hasPendingChanges')
  } else {
    icon = <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" strokeWidth={2} />
    label = status.lastSuccessAt ? t('syncStatus.synced') : t('syncStatus.pending')
    tooltip = status.lastSuccessAt
      ? t('syncStatus.syncedAt', { time: formatIsoDateTime(status.lastSuccessAt) })
      : t('syncStatus.neverSynced')
  }

  // 文档页 rail 让位：w-72=18rem / 收起 w-9=2.25rem，另加 0.75rem 边距
  const onDocPage = location.pathname.startsWith('/doc/')
  const positionClass = onDocPage
    ? (railCollapsed ? 'lg:right-[calc(2.25rem+0.75rem)]' : 'lg:right-[calc(18rem+0.75rem)]')
    : ''

  return (
    <Tooltip label={tooltip}>
      <button
        type="button"
        onClick={() => navigate('/settings/backup')}
        className={`fixed bottom-3 right-3 z-40 flex items-center gap-1.5 h-7 pl-2 pr-2.5 rounded-full border border-border/60 bg-card/90 backdrop-blur text-[11.5px] text-muted-foreground shadow-sm hover:border-border hover:text-foreground transition-colors ${positionClass}`}
        aria-label={t('syncStatus.statusLabel', { status: label })}
      >
        {icon}
        <span>{label}</span>
      </button>
    </Tooltip>
  )
}
