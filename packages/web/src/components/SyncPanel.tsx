import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, FolderOpen, Cloud, HardDrive, CheckCircle2, AlertCircle, ChevronDown, ChevronUp, Settings as SettingsIcon, Eye, EyeOff } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { ActionButton, useToast } from './ui'
import ConfirmDialog from './ConfirmDialog'

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

interface WebDavCfg {
  kind: 'webdav'
  endpoint: string
  username: string
  password: string
  prefix: string
  enabled: true
}

type FormState =
  | { kind: 'none' }
  | ({ kind: 'localfs' } & LocalFsCfg)
  | ({ kind: 's3' } & S3Cfg)
  | ({ kind: 'webdav' } & WebDavCfg)

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
const EMPTY_WEBDAV: WebDavCfg = {
  kind: 'webdav',
  endpoint: '',
  username: '',
  password: '',
  prefix: '',
  enabled: true,
}

const SECRET_MASK = '***set***'

export default function SyncPanel() {
  const [status, setStatus] = useState<SyncRuntimeStatus | null>(null)
  const [adapters, setAdapters] = useState<AdapterInfo[]>([])
  const [form, setForm] = useState<FormState>({ kind: 'none' })
  const [interval, setInterval] = useState(3600)
  const [collapsed, setCollapsed] = useState(false)
  const [info, setInfo] = useState<{ remoteDocCount?: number; extra: Record<string, unknown> } | null>(null)
  const [showS3Secret, setShowS3Secret] = useState(false)
  const [showWebDavSecret, setShowWebDavSecret] = useState(false)
  const [showDisableConfirm, setShowDisableConfirm] = useState(false)
  const toast = useToast()

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
        setForm({
          ...EMPTY_S3,
          ...a,
          accessKeyId: a.accessKeyId || SECRET_MASK,
          secretAccessKey: a.secretAccessKey || SECRET_MASK,
        })
      } else if (active?.kind === 'webdav') {
        const a = active as WebDavCfg
        setForm({
          ...EMPTY_WEBDAV,
          endpoint: a.endpoint ?? '',
          username: a.username || SECRET_MASK,
          password: a.password || SECRET_MASK,
          prefix: a.prefix ?? '',
        })
      } else {
        setForm({ kind: 'none' })
      }
      if (typeof res.status.autoSyncIntervalMs === 'number') {
        setInterval(Math.round(res.status.autoSyncIntervalMs / 1000))
      }
    } catch (e) {
      toast.error({ title: '加载归档配置失败', description: e instanceof Error ? e.message : String(e) })
    }
  }, [toast])

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
      toast.warning({ title: '请选择一种适配器' })
      return
    }
    await toast.promise(
      async () => {
        await api.put('/sync/config', {
          active: form,
          autoSyncIntervalMs: interval * 1000,
        })
        await refresh()
      },
      {
        loading: '正在保存归档配置…',
        success: '归档配置已保存',
        error: (e) => ({ title: '保存失败', description: e instanceof Error ? e.message : String(e) }),
      },
    ).catch(() => undefined)
  }

  const handleDisable = async () => {
    await toast.promise(
      async () => {
        await api.del('/sync/config')
        await refresh()
        setForm({ kind: 'none' })
      },
      {
        loading: '正在禁用…',
        success: 'Markdown 归档已禁用',
        error: (e) => ({ title: '禁用失败', description: e instanceof Error ? e.message : String(e) }),
      },
    ).catch(() => undefined)
  }

  const handleRun = async () => {
    await toast.promise(
      async () => {
        await api.post('/sync/run-now', {})
        await refresh()
      },
      {
        loading: '正在执行归档…',
        success: '归档完成',
        error: (e) => ({ title: '归档失败', description: e instanceof Error ? e.message : String(e) }),
      },
    ).catch(() => undefined)
  }

  const handleInfo = async () => {
    try {
      const r = await api.get<{ remoteDocCount?: number; extra?: Record<string, unknown> }>('/sync/info')
      setInfo({ remoteDocCount: r.remoteDocCount, extra: r.extra || {} })
    } catch (e) {
      setInfo(null)
      toast.error({
        title: '探测远端失败',
        description: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card shadow-[var(--shadow-card)] overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center justify-between gap-2 px-5 py-3.5 hover:bg-accent/60 transition-colors"
      >
        <div className="flex items-center gap-2.5 text-[13.5px] font-medium text-foreground">
          <SettingsIcon className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />
          <span>Markdown 归档（单向）</span>
          {status?.configured ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/12 text-emerald-600 dark:text-emerald-300 font-medium">
              {status.adapterName}
            </span>
          ) : (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
              未启用
            </span>
          )}
        </div>
        {collapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} /> : <ChevronUp className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />}
      </button>

      {!collapsed && (
        <div className="p-5 space-y-5">
          <p className="text-[12px] text-muted-foreground leading-relaxed -mt-1">
            将文档导出为 Markdown 推送到单一远端（LocalFS / S3 / WebDAV）。这是内容归档，不是完整数据库备份；
            不含 block ID、引用、标签与向量。同名文档使用带 ID 的文件名，删除会清理归档清单管理的陈旧文件。
          </p>
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
                    {a.kind === 'localfs' ? (
                      <FolderOpen className="w-4 h-4" />
                    ) : a.kind === 'webdav' ? (
                      <HardDrive className="w-4 h-4" />
                    ) : (
                      <Cloud className="w-4 h-4" />
                    )}
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
                <button
                  type="button"
                  onClick={() => setForm({ ...EMPTY_WEBDAV })}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border border-border bg-background hover:bg-accent"
                >
                  <HardDrive className="w-4 h-4" /> WebDAV
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

            {form.kind === 'webdav' && (
              <>
                <div className="text-[10.5px] text-muted-foreground/70 leading-relaxed -mt-1">
                  支持 NextCloud / ownCloud / 群晖 / 极空间 / 威联通 / 坚果云 WebDAV。
                  第一次推送时前缀不存在会创建中间目录。
                </div>
                <TextField
                  label="Endpoint URL"
                  value={form.endpoint}
                  onChange={(v) => setForm({ ...form, endpoint: v })}
                  placeholder="https://nas.local/dav/ 或 https://dav.jianguoyun.com/dav/"
                  mono
                />
                <TextField
                  label="用户名"
                  value={form.username}
                  onChange={(v) => setForm({ ...form, username: v })}
                  mono
                />
                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">密码 / 应用专用密码</label>
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      type={showWebDavSecret ? 'text' : 'password'}
                      value={form.password}
                      onChange={(e) => setForm({ ...form, password: e.target.value })}
                      placeholder="••••••••"
                      className="flex-1 px-3 py-1.5 text-sm rounded-md border border-border bg-background font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowWebDavSecret((s) => !s)}
                      className="p-1.5 text-muted-foreground hover:text-foreground rounded hover:bg-accent"
                    >
                      {showWebDavSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <TextField
                  label="远端子目录前缀（可选）"
                  value={form.prefix}
                  onChange={(v) => setForm({ ...form, prefix: v })}
                  placeholder="notes/"
                  mono
                />
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
                <ActionButton
                  onAction={handleSave}
                  successToast={{ title: status?.configured && status.adapterName === form.kind ? '归档配置已保存' : '归档已启用' }}
                  errorToast={(e) => ({ title: '保存失败', description: e instanceof Error ? e.message : String(e) })}
                >
                  {status?.configured && status.adapterName === form.kind ? '保存' : '启用'}
                </ActionButton>
                {status?.configured && (
                  <>
                    <ActionButton
                      variant="secondary"
                      size="sm"
                      onAction={handleRun}
                      successToast={{ title: '归档完成' }}
                      errorToast={(e) => ({ title: '归档失败', description: e instanceof Error ? e.message : String(e) })}
                    >
                      <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} />
                      立即归档
                    </ActionButton>
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
                      onClick={() => setShowDisableConfirm(true)}
                      className="inline-flex items-center justify-center gap-1.5 h-7 px-2.5 text-[12px] font-medium leading-none rounded-[var(--radius-btn)] text-destructive hover:bg-destructive/10 ml-auto min-w-[88px]"
                    >
                      禁用
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {(status?.lastRunAt || status?.lastResult) && (
            <div className="text-xs text-muted-foreground pt-2 border-t border-border/60 space-y-1">
              <div>
                上次归档：<span className="font-mono">{status?.lastRunAt || '尚未运行'}</span>
              </div>
              {status?.lastSuccessAt && status.lastResult && (
                <div className="text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" />
                  成功上传 {status.lastResult.pushed} 个文档
                </div>
              )}
              {status?.lastError && (
                <div className="text-destructive inline-flex items-start gap-1">
                  <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                  <span className="break-all">{status.lastError}</span>
                </div>
              )}
              {status?.lastResult?.errors && status.lastResult.errors.length > 0 && (
                <ul className="list-disc pl-4 space-y-0.5 text-destructive/90">
                  {status.lastResult.errors.slice(0, 5).map((err) => (
                    <li key={err} className="break-all">{err}</li>
                  ))}
                </ul>
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

      <ConfirmDialog
        open={showDisableConfirm}
        title="禁用 Markdown 归档"
        message="禁用后归档配置都会被清空。继续？"
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
