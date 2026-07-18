import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, FolderOpen, Loader2, CheckCircle2, AlertCircle, ChevronDown, ChevronUp, Settings as SettingsIcon } from 'lucide-react'
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

export default function SyncPanel() {
  const [status, setStatus] = useState<SyncRuntimeStatus | null>(null)
  const [adapters, setAdapters] = useState<AdapterInfo[]>([])
  const [dir, setDir] = useState('')
  const [interval, setInterval] = useState(3600)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<{ remoteDocCount: number; extra: Record<string, unknown> } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<{ configured: boolean; status: SyncRuntimeStatus }>('/sync/config')
      setStatus(res.status)
      setError(null)
      // 从磁盘配置回填表单（如果存在）
      const cfg = await api.get<{ config: { active: { dir?: string } | null } }>(`/sync/config`)
      if (cfg.config.active && 'dir' in cfg.config.active && cfg.config.active.dir) {
        setDir(cfg.config.active.dir)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    refresh()
    api.get<{ adapters: AdapterInfo[] }>('/sync/adapters').then((r) => setAdapters(r.adapters)).catch(() => undefined)
  }, [refresh])

  const handleSave = async () => {
    if (!dir.trim()) {
      setError('请填写目录路径')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await api.put('/sync/config', {
        active: { kind: 'localfs', dir: dir.trim(), enabled: true },
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
    setSaving(true)
    setError(null)
    try {
      await api.del('/sync/config')
      await refresh()
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
      setInfo({ remoteDocCount: r.remoteDocCount ?? 0, extra: r.extra || {} })
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
                    <FolderOpen className="w-4 h-4" />
                    <span className="font-medium">{a.label}</span>
                  </div>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {a.status === 'available' ? '可用' : '计划中'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {status?.configured && status.adapterName === 'localfs' && (
            <div className="space-y-3 pt-2 border-t border-border/60">
              <h4 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">本地文件系统</h4>
              <div>
                <label className="text-xs text-muted-foreground">导出目录</label>
                <input
                  type="text"
                  value={dir}
                  onChange={(e) => setDir(e.target.value)}
                  placeholder="/path/to/your/notes"
                  className="mt-1 w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary/30 font-mono"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">自动同步间隔（秒，0 = 关闭）</label>
                <input
                  type="number"
                  min={0}
                  max={86400}
                  value={interval}
                  onChange={(e) => setInterval(parseInt(e.target.value, 10) || 0)}
                  className="mt-1 w-32 px-3 py-1.5 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary/30 font-mono"
                />
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  保存
                </button>
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
                  onClick={handleDisable}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium text-destructive hover:bg-destructive/10"
                >
                  禁用
                </button>
              </div>
            </div>
          )}

          {!status?.configured && (
            <div className="space-y-3 pt-2 border-t border-border/60">
              <h4 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">启用本地文件系统同步</h4>
              <div>
                <label className="text-xs text-muted-foreground">导出目录（每个文档渲染为独立 .md 文件）</label>
                <input
                  type="text"
                  value={dir}
                  onChange={(e) => setDir(e.target.value)}
                  placeholder="./export"
                  className="mt-1 w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary/30 font-mono"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">自动同步间隔（秒，0 = 关闭）</label>
                <input
                  type="number"
                  min={0}
                  max={86400}
                  value={interval}
                  onChange={(e) => setInterval(parseInt(e.target.value, 10) || 0)}
                  className="mt-1 w-32 px-3 py-1.5 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary/30 font-mono"
                />
              </div>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || !dir.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                启用同步
              </button>
            </div>
          )}

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
              <div>远端 .md 文件数：<span className="font-mono">{info.remoteDocCount}</span></div>
              {typeof info.extra.dir === 'string' && (
                <div>目录：<span className="font-mono">{info.extra.dir}</span></div>
              )}
              {typeof info.extra.writable === 'boolean' && (
                <div>可写：<span className="font-mono">{String(info.extra.writable)}</span></div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
