import { useState, useEffect, useCallback } from 'react'
import {
  Database,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Copy,
  Plug,
} from 'lucide-react'
import { api } from '../hooks/useAPI'
import { BACKUP_SECRET_MASK, type BackupRuntimeStatus, type BackupRestorePoint } from '@notefast/core'
import { ActionButton, useToast } from './ui'
import ConfirmDialog from './ConfirmDialog'
import { SettingsCard, InlineField, StatusBadge } from './settings/ui'

interface BackupConfig {
  enabled: boolean
  intervalMs: number
  retentionDays: number
  s3: {
    bucket: string
    region: string
    endpoint?: string
    accessKeyId: string
    secretAccessKey: string
    prefix?: string
    forcePathStyle?: boolean
  } | null
}

export default function BackupPanel() {
  const [status, setStatus] = useState<BackupRuntimeStatus | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [bucket, setBucket] = useState('')
  const [region, setRegion] = useState('auto')
  const [endpoint, setEndpoint] = useState('')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [prefix, setPrefix] = useState('notefast-backup')
  const [forcePathStyle, setForcePathStyle] = useState(false)
  const [intervalHours, setIntervalHours] = useState(1)
  const [retentionDays, setRetentionDays] = useState(30)
  const [points, setPoints] = useState<BackupRestorePoint[]>([])
  const [showDisableConfirm, setShowDisableConfirm] = useState(false)
  const toast = useToast()

  const refresh = useCallback(async () => {
    const res = await api.get<{ configured: boolean; status: BackupRuntimeStatus; config: BackupConfig }>(
      '/backup/config',
    )
    setStatus(res.status)
    setEnabled(res.config.enabled)
    setIntervalHours(Math.max(0, Math.round((res.config.intervalMs || 0) / 3_600_000)))
    setRetentionDays(res.config.retentionDays || 30)
    if (res.config.s3) {
      setBucket(res.config.s3.bucket || '')
      setRegion(res.config.s3.region || 'auto')
      setEndpoint(res.config.s3.endpoint || '')
      setAccessKeyId(res.config.s3.accessKeyId || '')
      setSecretAccessKey(res.config.s3.secretAccessKey || '')
      setPrefix(res.config.s3.prefix?.replace(/\/$/, '') || '')
      setForcePathStyle(Boolean(res.config.s3.forcePathStyle))
    }
    if (res.configured) {
      try {
        const list = await api.get<{ points: BackupRestorePoint[] }>('/backup/restore-points?limit=20')
        setPoints(list.points)
      } catch {
        setPoints([])
      }
    } else {
      setPoints([])
    }
  }, [])

  useEffect(() => {
    refresh().catch((e) => {
      toast.error({ title: '加载备份配置失败', description: e instanceof Error ? e.message : String(e) })
    })
  }, [refresh, toast])

  const handleSave = async () => {
    await toast.promise(
      async () => {
        await api.put('/backup/config', {
          enabled,
          intervalMs: intervalHours * 3_600_000,
          retentionDays,
          s3: enabled
            ? {
                bucket,
                region,
                endpoint: endpoint || undefined,
                accessKeyId,
                secretAccessKey,
                prefix,
                forcePathStyle,
              }
            : null,
        })
        await refresh()
      },
      {
        loading: '正在保存备份配置…',
        success: '备份配置已保存',
        error: (e) => ({ title: '保存失败', description: e instanceof Error ? e.message : String(e) }),
      },
    ).catch(() => undefined)
  }

  const handleDisable = async () => {
    await api.del('/backup/config')
    await refresh()
  }

  const handleTest = async () => {
    await toast.promise(
      async () => {
        const r = await api.post<{ ok: boolean; error?: string }>('/backup/test', {})
        if (!r.ok) throw new Error(r.error || '连接失败')
      },
      {
        loading: '正在测试 S3 连接…',
        success: 'S3 连接正常',
        error: (e) => ({ title: '连接失败', description: e instanceof Error ? e.message : String(e) }),
      },
    ).catch(() => undefined)
  }

  const handleRun = async () => {
    await toast.promise(
      async () => {
        await api.post('/backup/run', {})
        await refresh()
      },
      {
        loading: '正在创建备份…',
        success: '备份完成',
        error: (e) => ({ title: '备份失败', description: e instanceof Error ? e.message : String(e) }),
      },
    ).catch(() => undefined)
  }

  const copyRestoreCmd = async (objectKey: string) => {
    const cmd = `bun --filter @notefast/server backup:restore -- --data-dir ./data --object-key ${objectKey} --yes`
    await navigator.clipboard.writeText(cmd)
    toast.success({ title: '已复制恢复命令', description: '请先停止 NoteFast 服务再执行' })
  }

  return (
    <SettingsCard
      title="数据库备份 (SQLite → S3)"
      icon={<Database className="w-4 h-4" strokeWidth={1.75} />}
      statusBadge={<StatusBadge active={!!status?.configured} label={status?.configured ? '已启用' : '未启用'} />}
      defaultExpanded={!status?.configured}
      dangerZone={
        status?.configured && (
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[13px] font-medium text-destructive">禁用数据库备份</div>
              <div className="text-[12px] text-destructive/70 mt-0.5">禁用后将停止自动备份，已有恢复点不会被删除。</div>
            </div>
            <button
              type="button"
              onClick={() => setShowDisableConfirm(true)}
              className="px-3 py-1.5 text-[12.5px] font-medium rounded-md bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
            >
              禁用备份
            </button>
          </div>
        )
      }
    >
      <div className="space-y-6">
        <div className="text-[12.5px] text-muted-foreground leading-relaxed bg-accent/30 p-3 rounded-lg border border-border/50">
          完整灾备：在线生成一致 SQLite 快照并上传 S3。默认每小时一次、保留 30 天。
          恢复须先停止服务，再执行 CLI（Web 不提供一键覆盖）。
        </div>

        <div className="flex items-center justify-between">
          <div className="text-[13px] font-medium text-foreground">启用自动备份</div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" className="sr-only peer" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <div className="w-9 h-5 bg-muted peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500"></div>
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4 pt-2">
          <InlineField label="Bucket" value={bucket} onChange={setBucket} mono placeholder="notefast-backup" />
          <InlineField label="Region" value={region} onChange={setRegion} mono placeholder="auto" />
          <InlineField
            label="Endpoint"
            description="R2 / MinIO 等兼容协议必填"
            value={endpoint}
            onChange={setEndpoint}
            mono
            placeholder="https://xxx.r2.cloudflarestorage.com"
          />
          <InlineField label="Key 前缀" value={prefix} onChange={setPrefix} mono placeholder="notefast-backup" />
          <InlineField
            label="Access Key ID"
            value={accessKeyId}
            onChange={setAccessKeyId}
            mono
            placeholder={BACKUP_SECRET_MASK}
          />
          <InlineField
            label="Secret Access Key"
            value={secretAccessKey}
            onChange={setSecretAccessKey}
            mono
            type="password"
            placeholder={BACKUP_SECRET_MASK}
          />
          <InlineField
            label="自动备份间隔"
            description="单位：小时，设为 0 表示仅手动备份"
            value={String(intervalHours)}
            onChange={(v) => setIntervalHours(parseInt(v, 10) || 0)}
            type="number"
          />
          <InlineField
            label="保留天数"
            value={String(retentionDays)}
            onChange={(v) => setRetentionDays(parseInt(v, 10) || 30)}
            type="number"
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
          {status?.configured && (
            <>
              <ActionButton variant="secondary" onAction={handleTest}>
                <Plug className="w-4 h-4 mr-1.5" strokeWidth={1.75} />
                测试连接
              </ActionButton>
              <ActionButton variant="secondary" onAction={handleRun}>
                <RefreshCw className="w-4 h-4 mr-1.5" strokeWidth={1.75} />
                立即备份
              </ActionButton>
            </>
          )}
        </div>

        {status && (
          <div className="text-[12.5px] text-muted-foreground pt-4 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">状态：</span>
              {status.running ? (
                <span className="text-amber-500 flex items-center gap-1"><RefreshCw className="w-3.5 h-3.5 animate-spin"/> 进行中 ({status.phase})</span>
              ) : (
                '空闲'
              )}
              {status.nextRunAt && (
                <span className="ml-2">下次备份：<span className="font-mono">{status.nextRunAt}</span></span>
              )}
            </div>
            {status.lastSuccessAt && (
              <div className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" />
                上次成功 {status.lastSuccessAt}
                {status.lastResult?.objectKey && (
                  <span className="font-mono ml-1 truncate max-w-[240px] text-[11.5px] opacity-80">{status.lastResult.objectKey}</span>
                )}
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

        {points.length > 0 && (
          <div className="space-y-3 pt-4 border-t border-border/40">
            <h4 className="text-[11.5px] uppercase tracking-[0.08em] text-muted-foreground font-semibold">
              最近恢复点
            </h4>
            <div className="space-y-2 max-h-60 overflow-y-auto pr-2 custom-scrollbar">
              {points.map((p) => (
                <div
                  key={p.objectKey}
                  className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-lg border border-border/60 bg-accent/10 text-[12.5px] hover:border-border transition-colors"
                >
                  <div className="min-w-0">
                    <div className="font-mono truncate font-medium text-foreground">{p.createdAt}</div>
                    <div className="text-muted-foreground truncate text-[11.5px] mt-0.5">
                      {(p.sizeBytes / 1024).toFixed(1)} KB · schema v{p.schemaVersion}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => copyRestoreCmd(p.objectKey)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-accent hover:text-foreground text-muted-foreground shrink-0 transition-colors border border-transparent hover:border-border/50"
                    title="复制恢复命令"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    <span>命令</span>
                  </button>
                </div>
              ))}
            </div>
            <p className="text-[11.5px] text-muted-foreground">
              恢复前请停止服务。可用 <code className="font-mono bg-accent/50 px-1 py-0.5 rounded text-[10.5px]">--dry-run</code> 预演。
            </p>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={showDisableConfirm}
        title="禁用数据库备份"
        message="禁用后将停止自动备份（已有恢复点不会删除）。继续？"
        confirmLabel="禁用"
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
