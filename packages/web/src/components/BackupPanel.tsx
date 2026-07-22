import { useState, useEffect, useCallback } from 'react'
import {
  Database,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Copy,
  Eye,
  EyeOff,
  Plug,
} from 'lucide-react'
import { api } from '../hooks/useAPI'
import { BACKUP_SECRET_MASK, type BackupRuntimeStatus, type BackupRestorePoint } from '@notefast/core'
import { ActionButton, useToast } from './ui'
import ConfirmDialog from './ConfirmDialog'

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
  const [collapsed, setCollapsed] = useState(false)
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
  const [showSecret, setShowSecret] = useState(false)
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
    <div className="rounded-xl border border-border bg-card shadow-[var(--shadow-card)] overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center justify-between gap-2 px-5 py-3.5 hover:bg-accent/60 transition-colors"
      >
        <div className="flex items-center gap-2.5 text-[13.5px] font-medium text-foreground">
          <Database className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />
          <span>数据库备份 (SQLite → S3)</span>
          {status?.configured ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/12 text-emerald-600 dark:text-emerald-300 font-medium">
              已启用
            </span>
          ) : (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
              未启用
            </span>
          )}
        </div>
        {collapsed ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />
        ) : (
          <ChevronUp className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />
        )}
      </button>

      {!collapsed && (
        <div className="p-5 space-y-5">
          <p className="text-[12px] text-muted-foreground leading-relaxed">
            完整灾备：在线生成一致 SQLite 快照并上传 S3。默认每小时一次、保留 30 天。
            恢复须先停止服务，再执行 CLI（Web 不提供一键覆盖）。
          </p>

          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>启用数据库备份</span>
          </label>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Bucket" value={bucket} onChange={setBucket} mono placeholder="notefast-backup" />
            <Field label="Region" value={region} onChange={setRegion} mono placeholder="auto" />
            <Field
              label="Endpoint（R2 / MinIO 必填）"
              value={endpoint}
              onChange={setEndpoint}
              mono
              placeholder="https://xxx.r2.cloudflarestorage.com"
            />
            <Field label="Key 前缀" value={prefix} onChange={setPrefix} mono placeholder="notefast-backup" />
            <Field
              label="Access Key ID"
              value={accessKeyId}
              onChange={setAccessKeyId}
              mono
              placeholder={BACKUP_SECRET_MASK}
            />
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Secret Access Key
              </label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type={showSecret ? 'text' : 'password'}
                  value={secretAccessKey}
                  onChange={(e) => setSecretAccessKey(e.target.value)}
                  placeholder={BACKUP_SECRET_MASK}
                  className="flex-1 px-3 py-1.5 text-sm rounded-md border border-border bg-background font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret((s) => !s)}
                  className="p-1.5 text-muted-foreground hover:text-foreground rounded hover:bg-accent"
                >
                  {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <Field
              label="自动备份间隔（小时，0=仅手动）"
              value={String(intervalHours)}
              onChange={(v) => setIntervalHours(parseInt(v, 10) || 0)}
              type="number"
            />
            <Field
              label="保留天数"
              value={String(retentionDays)}
              onChange={(v) => setRetentionDays(parseInt(v, 10) || 30)}
              type="number"
            />
          </div>

          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={forcePathStyle}
              onChange={(e) => setForcePathStyle(e.target.checked)}
            />
            <span>Path-style endpoint（MinIO 通常需要）</span>
          </label>

          <div className="flex items-center gap-2 flex-wrap">
            <ActionButton onAction={handleSave}>保存</ActionButton>
            {status?.configured && (
              <>
                <ActionButton variant="secondary" size="sm" onAction={handleTest}>
                  <Plug className="w-3.5 h-3.5" strokeWidth={1.75} />
                  测试连接
                </ActionButton>
                <ActionButton variant="secondary" size="sm" onAction={handleRun}>
                  <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} />
                  立即备份
                </ActionButton>
                <button
                  type="button"
                  onClick={() => setShowDisableConfirm(true)}
                  className="inline-flex items-center justify-center gap-1.5 h-7 px-2.5 text-[12px] font-medium leading-none rounded-[var(--radius-btn)] text-destructive hover:bg-destructive/10 ml-auto min-w-[88px]"
                >
                  禁用
                </button>
              </>
            )}
          </div>

          {status && (
            <div className="text-xs text-muted-foreground pt-2 border-t border-border/60 space-y-1">
              <div>
                状态：{status.running ? `进行中 (${status.phase})` : '空闲'}
                {status.nextRunAt && (
                  <span className="ml-2">下次：<span className="font-mono">{status.nextRunAt}</span></span>
                )}
              </div>
              {status.lastSuccessAt && (
                <div className="text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" />
                  上次成功 {status.lastSuccessAt}
                  {status.lastResult?.objectKey && (
                    <span className="font-mono ml-1 truncate max-w-[240px]">{status.lastResult.objectKey}</span>
                  )}
                </div>
              )}
              {status.lastError && (
                <div className="text-destructive inline-flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  {status.lastError}
                </div>
              )}
            </div>
          )}

          {points.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-border/60">
              <h4 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
                恢复点
              </h4>
              <div className="space-y-1.5">
                {points.map((p) => (
                  <div
                    key={p.objectKey}
                    className="flex items-center justify-between gap-2 px-3 py-2 rounded-md border border-border bg-background text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-mono truncate">{p.createdAt}</div>
                      <div className="text-muted-foreground truncate">
                        {(p.sizeBytes / 1024).toFixed(1)} KB · schema v{p.schemaVersion}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => copyRestoreCmd(p.objectKey)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-accent shrink-0"
                      title="复制恢复命令"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      恢复命令
                    </button>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                恢复前请停止服务。可用 <code className="font-mono">--dry-run</code> 预演。
              </p>
            </div>
          )}
        </div>
      )}

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
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  mono,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: 'text' | 'number'
  mono?: boolean
}) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`mt-1 w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary/30 ${mono ? 'font-mono' : ''}`}
      />
    </div>
  )
}
