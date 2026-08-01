import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, ArrowDownToLine, ArrowUpFromLine, CheckCircle2, AlertCircle, Cloud } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { ActionButton, useToast } from './ui'
import { SettingsCard, StatusBadge } from './settings/ui'

/**
 * 同步协议状态面板（方案 A：客户端与 Web 共享同一份 S3）
 *
 * 复用数据库备份的 S3 配置（同一凭据/bucket，独立前缀 {prefix}sync/），无需独立配置表单。
 * 只做：状态展示 + 手动触发（发布 / 拉取）。
 */

interface SyncProtocolStatus {
  configured: boolean
  enabled: boolean
  s3Bucket?: string
  s3Prefix?: string
  lastRunAt?: string
  lastSuccessAt?: string
  lastError?: string
  state: { publishedSeq: number; consumedSeq: number; sinceSnapshot: number }
  running: boolean
  autoSyncIntervalMs: number
}

const EMPTY_STATUS: SyncProtocolStatus = {
  configured: false,
  enabled: false,
  state: { publishedSeq: 0, consumedSeq: 0, sinceSnapshot: 0 },
  running: false,
  autoSyncIntervalMs: 0,
}

export default function SyncProtocolPanel() {
  const [status, setStatus] = useState<SyncProtocolStatus>(EMPTY_STATUS)
  const toast = useToast()

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<SyncProtocolStatus>('/sync/protocol')
      setStatus(res)
    } catch {
      setStatus(EMPTY_STATUS)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const doPull = async () => {
    const res = await api.post<{ mode?: string; applied?: number; mediaRestored?: number }>('/sync/protocol/pull', {})
    const detail = `模式 ${res.mode === 'full' ? '全量恢复' : '增量合并'}${(res.applied ?? 0) > 0 ? `，合并 ${res.applied} 条` : ''}${(res.mediaRestored ?? 0) > 0 ? `，拉回 ${res.mediaRestored} 张图` : ''}`
    toast.success({ title: '拉取完成', description: detail })
  }

  const doRun = async () => {
    const res = await api.post<{ published?: number }>('/sync/protocol/run', {})
    toast.success({ title: '同步完成', description: (res.published ?? 0) > 0 ? `发布 ${res.published} 条变更` : '无新变更' })
  }

  const hasError = Boolean(status.lastError)
  const lastRunText = status.lastSuccessAt
    ? new Date(status.lastSuccessAt).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : '从未'

  return (
    <SettingsCard
      title="同步协议 (S3)"
      icon={<Cloud className="w-4 h-4" strokeWidth={1.75} />}
      helpTip="在 Web 端与客户端之间共享同一份 S3 数据：本端变更发布到 S3，同时拉取远端变更合并进本地（LWW 按更新时间裁决）。复用「数据库备份」的 S3 配置，使用独立前缀，不额外占用配置项。"
      statusBadge={
        <StatusBadge active={status.enabled} label={status.enabled ? '已启用' : '未配置'} />
      }
      defaultExpanded={false}
    >
      <div className="space-y-4">
        {/* 状态摘要 */}
        <div className="grid grid-cols-2 gap-2.5 text-[12px]">
          <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
            <div className="text-muted-foreground/70">上次同步</div>
            <div className="font-medium text-foreground mt-0.5">{lastRunText}</div>
          </div>
          <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
            <div className="text-muted-foreground/70">S3 存储</div>
            <div className="font-medium text-foreground mt-0.5 truncate">
              {status.s3Bucket ? `s3://${status.s3Bucket}/${status.s3Prefix ?? ''}sync/` : '未配置'}
            </div>
          </div>
        </div>

        {/* 游标状态 */}
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground/70">
          <span>已发布 seq：<span className="font-mono text-foreground/80 tabular-nums">{status.state.publishedSeq}</span></span>
          <span>已消费 seq：<span className="font-mono text-foreground/80 tabular-nums">{status.state.consumedSeq}</span></span>
          {status.autoSyncIntervalMs > 0 && (
            <span>自动：{Math.round(status.autoSyncIntervalMs / 60000)} 分钟</span>
          )}
        </div>

        {hasError && (
          <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" strokeWidth={1.75} />
            <span>{status.lastError}</span>
          </div>
        )}

        {/* 操作 */}
        <div className="flex items-center gap-2">
          <ActionButton
            onAction={doPull}
            disabled={!status.enabled}
            icon={<ArrowDownToLine className="w-3.5 h-3.5" strokeWidth={1.75} />}
            onAfter={refresh}
          >
            拉取 (恢复)
          </ActionButton>
          <ActionButton
            onAction={doRun}
            disabled={!status.enabled}
            icon={<ArrowUpFromLine className="w-3.5 h-3.5" strokeWidth={1.75} />}
            onAfter={refresh}
          >
            发布 (推送)
          </ActionButton>
          <button
            type="button"
            onClick={refresh}
            className="ml-auto p-1.5 text-muted-foreground/60 hover:text-foreground rounded-md transition-colors"
            title="刷新状态"
          >
            <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} />
          </button>
          {status.lastSuccessAt && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" strokeWidth={1.75} />}
        </div>

        <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
          首次拉取会从 S3 快照全量恢复到本地；日常为增量合并。此能力主要为客户端多端同步设计，Web 端可作为手动对账入口。
        </p>
      </div>
    </SettingsCard>
  )
}
