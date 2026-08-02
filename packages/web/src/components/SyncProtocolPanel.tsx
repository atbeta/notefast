import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, ArrowDownToLine, ArrowUpFromLine, CheckCircle2, AlertCircle, Cloud } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { ActionButton, useToast } from './ui'
import ConfirmDialog from './ConfirmDialog'
import { SettingsCard, StatusBadge, InlineField } from './settings/ui'
import { SYNC_SECRET_MASK, type SyncProtocolS3Config } from '@notefast/core'
import { formatIsoDateTime } from '../lib/time'

/**
 * 多端同步面板：双向增量同步（发布/拉取），独立 S3 配置，与「数据库备份」完全解耦。
 */

interface SyncProtocolState {
  publishedSeq: number
  consumedSeq: number
  sinceSnapshot: number
}

interface SyncProtocolStatus {
  configured: boolean
  enabled: boolean
  s3Bucket?: string
  s3Prefix?: string
  lastRunAt?: string
  lastSuccessAt?: string
  lastError?: string
  state: SyncProtocolState
  running: boolean
}

const EMPTY_STATUS: SyncProtocolStatus = {
  configured: false,
  enabled: false,
  state: { publishedSeq: 0, consumedSeq: 0, sinceSnapshot: 0 },
  running: false,
}

export default function SyncProtocolPanel() {
  const [status, setStatus] = useState<SyncProtocolStatus>(EMPTY_STATUS)
  const [enabled, setEnabled] = useState(false)
  const [bucket, setBucket] = useState('')
  const [region, setRegion] = useState('us-east-1')
  const [endpoint, setEndpoint] = useState('')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [prefix, setPrefix] = useState('')
  const [forcePathStyle, setForcePathStyle] = useState(false)
  const [showDisableConfirm, setShowDisableConfirm] = useState(false)
  const toast = useToast()

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<{ configured: boolean; config: { enabled: boolean; s3: SyncProtocolS3Config | null }; status: SyncProtocolStatus }>('/sync/protocol/config')
      setStatus(res.status)
      setEnabled(res.config.enabled)
      if (res.config.s3) {
        setBucket(res.config.s3.bucket || '')
        setRegion(res.config.s3.region || 'us-east-1')
        setEndpoint(res.config.s3.endpoint || '')
        // 脱敏占位符 = 已有密钥：不填进输入框（提交留空时后端保留旧值）
        setAccessKeyId(res.config.s3.accessKeyId === SYNC_SECRET_MASK ? '' : res.config.s3.accessKeyId || '')
        setSecretAccessKey(res.config.s3.secretAccessKey === SYNC_SECRET_MASK ? '' : res.config.s3.secretAccessKey || '')
        setPrefix((res.config.s3.prefix ?? '').replace(/\/$/, ''))
        setForcePathStyle(Boolean(res.config.s3.forcePathStyle))
      }
    } catch {
      setStatus(EMPTY_STATUS)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleSave = async () => {
    await toast.promise(
      async () => {
        // 填了 bucket 即视为「要配置多端同步」——不受独立开关误伤
        const hasS3 = Boolean(bucket.trim())
        await api.put('/sync/protocol/config', {
          enabled: enabled || hasS3,
          s3: hasS3
            ? {
                bucket,
                region,
                endpoint: endpoint || undefined,
                // 空字符串 = 未填 → undefined（JSON.stringify 省略），后端保留旧值
                accessKeyId: accessKeyId || undefined,
                secretAccessKey: secretAccessKey || undefined,
                prefix,
                forcePathStyle,
              }
            : null,
        })
        await refresh()
      },
      {
        loading: '正在保存多端同步配置…',
        success: '多端同步配置已保存',
        error: (e) => ({ title: '保存失败', description: e instanceof Error ? e.message : String(e) }),
      },
    ).catch(() => undefined)
  }

  const handleDisable = async () => {
    await api.del('/sync/protocol/config')
    await refresh()
  }

  const doPull = async () => {
    const res = await api.post<{ mode?: string; applied?: number; mediaRestored?: number }>('/sync/protocol/pull', {})
    const detail = `模式 ${res.mode === 'full' ? '全量恢复' : '增量合并'}${(res.applied ?? 0) > 0 ? `，合并 ${res.applied} 条` : ''}${(res.mediaRestored ?? 0) > 0 ? `，拉回 ${res.mediaRestored} 张图` : ''}`
    toast.success({ title: '拉取完成', description: detail })
  }

  const doRun = async () => {
    const res = await api.post<{ published?: number }>('/sync/protocol/run', {})
    toast.success({ title: '同步完成', description: (res.published ?? 0) > 0 ? `发布 ${res.published} 条变更` : '无新变更' })
  }

  const lastRunText = status.lastSuccessAt
    ? formatIsoDateTime(status.lastSuccessAt)
    : '从未'

  return (
    <SettingsCard
      title="多端同步 (S3)"
      icon={<Cloud className="w-4 h-4" strokeWidth={1.75} />}
      helpTip="在 Web 端与客户端之间共享同一份 S3 数据：本端变更发布到 S3，同时拉取远端变更合并进本地（LWW 按更新时间裁决）。与「数据库备份」相互独立，使用各自的 S3 配置。同步完全自动：任何写入（Web/MCP/导入/AI）都会立即触发发布，并定期心跳拉取远端变更。"
      statusBadge={
        <StatusBadge active={status.enabled} label={status.enabled ? '已启用' : '未配置'} />
      }
      defaultExpanded={!status?.configured}
      dangerZone={
        status?.configured && (
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[13px] font-medium text-destructive">停用多端同步</div>
              <div className="text-[12px] text-destructive/70 mt-0.5">停用后不再自动同步，远端已有数据不会被删除。</div>
            </div>
            <button
              type="button"
              onClick={() => setShowDisableConfirm(true)}
              className="px-3 py-1.5 text-[12.5px] font-medium rounded-md bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
            >
              停用同步
            </button>
          </div>
        )
      }
    >
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-medium text-foreground">启用多端同步</div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" className="sr-only peer" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <div className="w-9 h-5 bg-muted peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500"></div>
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4 pt-2">
          <InlineField label="Bucket" value={bucket} onChange={setBucket} mono placeholder="my-notefast-bucket" />
          <InlineField label="Region" value={region} onChange={setRegion} mono placeholder="us-east-1" />
          <InlineField
            label="Endpoint"
            description="R2 / MinIO 等兼容协议必填"
            value={endpoint}
            onChange={setEndpoint}
            mono
            placeholder="https://xxx.r2.cloudflarestorage.com"
          />
          <InlineField label="Key 前缀" value={prefix} onChange={setPrefix} mono placeholder="sync" />
          <InlineField
            label="Access Key ID"
            value={accessKeyId}
            onChange={setAccessKeyId}
            mono
            placeholder={SYNC_SECRET_MASK}
          />
          <InlineField
            label="Secret Access Key"
            value={secretAccessKey}
            onChange={setSecretAccessKey}
            mono
            type="password"
            placeholder={SYNC_SECRET_MASK}
          />
        </div>

        <div className="flex items-center justify-between pt-2">
          <label className="flex items-center gap-3 cursor-pointer">
            <span className="text-[13px] font-medium text-foreground">Path-style endpoint</span>
            <span className="text-[11px] text-muted-foreground/60 -ml-1.5">MinIO 必需，AWS / R2 默认关闭</span>
            <div className="relative inline-flex items-center">
              <input type="checkbox" className="sr-only peer" checked={forcePathStyle} onChange={(e) => { setForcePathStyle(e.target.checked) }} />
              <div className="w-9 h-5 bg-muted peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500"></div>
            </div>
          </label>
        </div>

        <div className="flex items-center gap-3 pt-4 border-t border-border/40">
          <ActionButton onAction={handleSave}>保存全部更改</ActionButton>
          {status.enabled && (
            <>
              <ActionButton variant="secondary" onAction={doPull} icon={<ArrowDownToLine className="w-4 h-4 mr-1.5" strokeWidth={1.75} />}>
                拉取 (恢复)
              </ActionButton>
              <ActionButton variant="secondary" onAction={doRun} icon={<ArrowUpFromLine className="w-4 h-4 mr-1.5" strokeWidth={1.75} />}>
                发布 (推送)
              </ActionButton>
            </>
          )}
          <button
            type="button"
            onClick={refresh}
            className="ml-auto p-1.5 text-muted-foreground/60 hover:text-foreground rounded-md transition-colors"
            title="刷新状态"
          >
            <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} />
          </button>
        </div>

        {status && (
          <div className="text-[12.5px] text-muted-foreground pt-4 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">状态：</span>
              {status.running ? (
                <span className="text-amber-500 flex items-center gap-1"><RefreshCw className="w-3.5 h-3.5 animate-spin"/> 同步中</span>
              ) : (
                '空闲'
              )}
              <span className="ml-2">上次同步：<span className="font-mono">{lastRunText}</span></span>
              <span className="ml-2">存储：<span className="font-mono truncate max-w-[240px] inline-block align-bottom">{status.s3Bucket ? `s3://${status.s3Bucket}/${status.s3Prefix ?? ''}sync/` : '未配置'}</span></span>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground/70">
              <span>已发布 seq：<span className="font-mono text-foreground/80 tabular-nums">{status.state.publishedSeq}</span></span>
              <span>已消费 seq：<span className="font-mono text-foreground/80 tabular-nums">{status.state.consumedSeq}</span></span>
              {status.enabled && (
                <span className="text-emerald-600/80">自动同步已开启</span>
              )}
            </div>
            {status.lastSuccessAt && (
              <div className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" />
                上次成功 {formatIsoDateTime(status.lastSuccessAt)}
              </div>
            )}
            {status.lastError && (
              <div className="text-destructive flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5" />
                上次失败：{status.lastError}
              </div>
            )}
          </div>
        )}

        <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
          首次拉取会从 S3 快照全量恢复到本地；日常为增量合并。此能力主要为客户端多端同步设计，Web 端可作为手动对账入口。
        </p>
      </div>

      <ConfirmDialog
        open={showDisableConfirm}
        title="停用多端同步"
        message="停用后不再自动同步（远端已有数据不会删除，也不会丢失）。继续？"
        confirmLabel="停用"
        destructive
        onCancel={() => setShowDisableConfirm(false)}
        onConfirm={() => {
          setShowDisableConfirm(false)
          void handleDisable()
        }}
      />
    </SettingsCard>
  )
}
