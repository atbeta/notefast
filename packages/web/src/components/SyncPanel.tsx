import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, FolderOpen, Cloud, Loader2, CheckCircle2, AlertCircle, ChevronDown, ChevronUp, Settings as SettingsIcon, Eye, EyeOff } from 'lucide-react'
import { api } from '../hooks/useAPI'

interface SyncRuntimeStatus {
  configured: boolean
  adapterName?: string
  enabled: boolean
  lastRunAt?: string
  lastSuccessAt?: string
  lastError?: string
  lastResult?: {
    pushed: number
    pulled: number
    errors: string[]
  } | null
  autoSyncIntervalMs?: number
}

interface AdapterInfo {
  kind: string
  label: string
  fields: Array<{ name: string; label: string; type: string; required: boolean; secret?: boolean }>
  status: 'available' | 'planned'
}

interface LocalFsCfg {
  kind: 'localfs'
  dir: string
  prefix: string
  enabled: true
}

interface S3Cfg {
  kind: 's3'
  bucket: string
  region: string
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  prefix: string
  forcePathStyle: boolean
  enabled: true
}

type FormState =
  | { kind: 'none' }
  | ({ kind: 'localfs' } & LocalFsCfg)
  | ({ kind: 's3' } & S3Cfg)

const EMPTY_LOCALFS: LocalFsCfg = { kind: 'localfs', dir: '', prefix: '', enabled: true }
const EMPTY_S3: S3Cfg = {
  kind: 's3',
  bucket: '',
  region: 'us-east-1',
  endpoint: '',
  accessKeyId: '',
  secretAccessKey: '',
  prefix: '',
  forcePathStyle: false,
  enabled: true,
}

export default function SyncPanel() {
  const [status, setStatus] = useState<SyncRuntimeStatus | null>(null)
  const [adapters, setAdapters] = useState<AdapterInfo[]>([])
  const [form, setForm] = useState<FormState>({ kind: 'none' })
  const [interval, setInterval] = useState(3600)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<{ remoteDocCount?: number; extra: Record<string, unknown> } | null>(null)
  const [showS3Secret, setShowS3Secret] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<{ configured: boolean; status: SyncRuntimeStatus; config: { active: unknown } }>('/sync/config')
      setStatus(res.status)
      setAdaptersInfo(res)
      const active = res.config.active as { kind?: string } | null
      if (active?.kind === 'localfs') {
        const a = active as LocalFsCfg
        setForm({ ...EMPTY_LOCALFS, dir: a.dir ?? '', prefix: a.prefix ?? '' })
      } else if (active?.kind === 's3') {
        const a = active as S3Cfg
        setForm({ ...EMPTY_S3, ...a })
      } else {
        setForm({ kind: 'none' })
      }
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const setAdaptersInfo = useCallback(async (_res: unknown) => {
    try {
      const r = await api.get<{ adapters: AdapterInfo[] }>('/sync/adapters')
      setAdapters(r.adapters)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    refresh()
    api.get<{ adapters: AdapterInfo[] }>('/sync/adapters').then((r) => setAdapters(r.adapters)).catch(() => undefined)
  }, [refresh])

  const handleSave = async () => {
    if (form.kind === 'none') {
      setError('请选择一种适配器')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await api.put('/sync/config', {
        active: form,
        autoSyncIntervalMs: interval * 1000,
      })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleDisable = async () => {
    if (!confirm('禁用后所有同步配置都会被清空。继续？')) return
    setSaving(true)
    setError(null)
    try {
      await api.del('/sync/config')
      await refresh()
      setForm({ kind: 'none' })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleRun = async () => {
    setRunning(true)
    setError(null)
    try {
      await api.post('/sync/run-now', {})
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  const handleInfo = async () => {
    setError(null)
    try {
      const r = await api.get<{ remoteDocCount?: number; extra?: Record<string, unknown> }>('/sync/info')
      setInfo({ remoteDocCount: r.remoteDocCount, extra: r.extra || {} })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setInfo(null)
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center justify-between gap-2 px-5 py-3 bg-background/50 hover:bg-accent transition-colors"
      >
        <div className="flex items-center gap-2 text-sm font-medium">
          <SettingsIcon className="w-4 h-4 text-primary" />
          <span>数据同步 (Sync)</span>
          {status?.configured ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-300">
              {status.adapterName}
            </span>
          ) : (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
              未启用
            </span>
          )}
        </div>
        {collapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronUp className="w-4 h-4 text-muted-foreground" />}
      </button>

      {!collapsed && (
        <div className="p-5 space-y-5">
          {error && (
            <div className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </div>
          )}

          {/* Adapter catalog */}
          <div className="space-y-3">
            <h4 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">适配器</h4>
            <div className="grid gap-2 text-sm">
              {adapters.map((a) => (
                <div
                  key={a.kind}
                  className={`flex items-center justify-between px-3 py-2 rounded-md border ${
                    a.status === 'available'
                      ? 'border-border bg-background'
                      : 'border-border/40 bg-muted/30 text-muted-foreground'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {a.kind === 'localfs' ? <FolderOpen className="w-4 h-4" /> : <Cloud className="w-4 h-4" />}
                    <span className="font-medium">{a.label}</span>
                  </div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {a.status === 'available' ? '可用' : '计划中'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Configuration form */}
          <div className="space-y-3 pt-2 border-t border-border/60">
            <h4 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">启用方式</h4>

            {form.kind === 'none' && (
              <div className="flex gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => setForm({ ...EMPTY_LOCALFS })}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border border-border bg-background hover:bg-accent"
                >
                  <FolderOpen className="w-4 h-4" /> 本地文件
                </button>
                <button
                  type="button"
                  onClick={() => setForm({ ...EMPTY_S3 })}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border border-border bg-background hover:bg-accent"
                >
                  <Cloud className="w-4 h-4" /> S3 兼容
                </button>
              </div>
            )}

            {form.kind === 'localfs' && (
              <>
                <TextField label="导出目录" value={form.dir} onChange={(v) => setForm({ ...form, dir: v })} placeholder="/path/to/your/notes" mono />
                <TextField label="文件名前缀（可选）" value={form.prefix} onChange={(v) => setForm({ ...form, prefix: v })} placeholder="notes/" mono />
              </>
            )}

            {form.kind === 's3' && (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <TextField label="Bucket" value={form.bucket} onChange={(v) => setForm({ ...form, bucket: v })} placeholder="my-notefast-bucket" mono />
                  <TextField label="Region" value={form.region} onChange={(v) => setForm({ ...form, region: v })} placeholder="us-east-1" mono />
                  <TextField label="Endpoint（MinIO / R2 / OSS 必填）" value={form.endpoint} onChange={(v) => setForm({ ...form, endpoint: v })} placeholder="https://s3.amazonaws.com" mono />
                  <TextField label="Key 前缀" value={form.prefix} onChange={(v) => setForm({ ...form, prefix: v })} placeholder="notes/" mono />
                  <TextField label="Access Key ID" value={form.accessKeyId} onChange={(v) => setForm({ ...form, accessKeyId: v })} placeholder="AKIA..." mono />
                  <div>
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Secret Access Key</label>
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        type={showS3Secret ? 'text' : 'password'}
                        value={form.secretAccessKey}
                        onChange={(e) => setForm({ ...form, secretAccessKey: e.target.value })}
                        placeholder="••••••••"
                        className="flex-1 px-3 py-1.5 text-sm rounded-md border border-border bg-background font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => setShowS3Secret((s) => !s)}
                        className="p-1.5 text-muted-foreground hover:text-foreground rounded hover:bg-accent"
                      >
                        {showS3Secret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                </div>
                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.forcePathStyle}
                    onChange={(e) => setForm({ ...form, forcePathStyle: e.target.checked })}
                  />
                  <span>Path-style endpoint（MinIO 必需，AWS / R2 默认关闭）</span>
                </label>
              </>
            )}

            {form.kind !== 'none' && (
              <TextField
                label="自动同步间隔（秒，0 = 关闭）"
                value={String(interval)}
                type="number"
                onChange={(v) => setInterval(parseInt(v, 10) || 0)}
                mono
              />
            )}

            {form.kind !== 'none' && (
              <div className="flex items-center gap-2 flex-wrap pt-1">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  {status?.configured && status.adapterName === (form.kind === 'localfs' ? 'localfs' : 's3') ? '保存' : '启用'}
                </button>
                {status?.configured && (
                  <>
                    <button
                      type="button"
                      onClick={handleRun}
                      disabled={running}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-secondary text-secondary-foreground hover:bg-accent disabled:opacity-50"
                    >
                      {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                      立即同步
                    </button>
                    <button
                      type="button"
                      onClick={handleInfo}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent"
                    >
                      探测远端
                    </button>
                    <button
                      type="button"
                      onClick={() => setForm({ kind: 'none' })}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent"
                      title="切换到另一种适配器"
                    >
                      切换适配器
                    </button>
                    <button
                      type="button"
                      onClick={handleDisable}
                      disabled={saving}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium text-destructive hover:bg-destructive/10 ml-auto"
                    >
                      禁用
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {status?.lastResult && (
            <div className="text-xs text-muted-foreground pt-2 border-t border-border/60 space-y-1">
              <div>
                上次同步：<span className="font-mono">{status.lastRunAt || '尚未运行'}</span>
              </div>
              {status.lastSuccessAt && (
                <div className="text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" />
                  成功上传 {status.lastResult.pushed} 个文档
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

          {info && (
            <div className="text-xs text-muted-foreground bg-muted/40 px-3 py-2 rounded-md space-y-0.5">
              {typeof info.remoteDocCount === 'number' && (
                <div>远端 .md 文件数：<span className="font-mono">{info.remoteDocCount}</span></div>
              )}
              {Object.entries(info.extra).map(([k, v]) => (
                <div key={k}>{k}：<span className="font-mono">{String(v)}</span></div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function TextField({
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
