import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, FolderOpen, Cloud, HardDrive, CheckCircle2, AlertCircle, Settings as SettingsIcon } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { SYNC_SECRET_MASK, type LocalFsAdapterConfig, type S3AdapterConfig, type WebDavAdapterConfig } from '@notefast/core'
import { ActionButton, useToast } from './ui'
import ConfirmDialog from './ConfirmDialog'
import { SettingsCard, InlineField, StatusBadge } from './settings/ui'

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

type FormState =
  | { kind: 'none' }
  | LocalFsAdapterConfig
  | S3AdapterConfig
  | WebDavAdapterConfig

const EMPTY_LOCALFS: LocalFsAdapterConfig = { kind: 'localfs', dir: '', prefix: '', enabled: true }
const EMPTY_S3: S3AdapterConfig = {
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
const EMPTY_WEBDAV: WebDavAdapterConfig = {
  kind: 'webdav',
  endpoint: '',
  username: '',
  password: '',
  prefix: '',
  enabled: true,
}

export default function SyncPanel() {
  const [status, setStatus] = useState<SyncRuntimeStatus | null>(null)
  const [adapters, setAdapters] = useState<AdapterInfo[]>([])
  const [form, setForm] = useState<FormState>({ kind: 'none' })
  const [interval, setInterval] = useState(3600)
  const [info, setInfo] = useState<{ remoteDocCount?: number; extra: Record<string, unknown> } | null>(null)
  const [showDisableConfirm, setShowDisableConfirm] = useState(false)
  const toast = useToast()

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<{ configured: boolean; status: SyncRuntimeStatus; config: { active: unknown } }>('/sync/config')
      setStatus(res.status)
      const active = res.config.active as { kind?: string } | null
      if (active?.kind === 'localfs') {
        const a = active as LocalFsAdapterConfig
        setForm({ ...EMPTY_LOCALFS, dir: a.dir ?? '', prefix: a.prefix ?? '' })
      } else if (active?.kind === 's3') {
        const a = active as S3AdapterConfig
        setForm({
          ...EMPTY_S3,
          ...a,
          accessKeyId: a.accessKeyId || SYNC_SECRET_MASK,
          secretAccessKey: a.secretAccessKey || SYNC_SECRET_MASK,
        })
      } else if (active?.kind === 'webdav') {
        const a = active as WebDavAdapterConfig
        setForm({
          ...EMPTY_WEBDAV,
          endpoint: a.endpoint ?? '',
          username: a.username || SYNC_SECRET_MASK,
          password: a.password || SYNC_SECRET_MASK,
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

  useEffect(() => {
    refresh()
    // 适配器目录只在挂载时拉一次；refresh() 只刷主数据（/sync/config），不再重复拉取
    api.get<{ adapters: AdapterInfo[] }>('/sync/adapters').then((r) => setAdapters(r.adapters)).catch(() => undefined)
  }, [refresh])

  const handleSave = async () => {
    await api.put('/sync/config', {
      active: form,
      autoSyncIntervalMs: interval * 1000,
    })
    await refresh()
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
      }
    ).catch(() => undefined)
  }

  const handleRun = async () => {
    await api.post('/sync/run-now', {})
    await refresh()
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
    <SettingsCard
      title="Markdown 归档"
      icon={<SettingsIcon className="w-4 h-4" strokeWidth={1.75} />}
      statusBadge={<StatusBadge active={!!status?.configured} label={status?.configured ? `已启用 · ${status.adapterName}` : '未启用'} />}
      defaultExpanded={!status?.configured}
    >
      <div className="space-y-6">
        <div className="text-[12.5px] text-muted-foreground leading-relaxed bg-accent/30 p-3 rounded-lg border border-border/50">
          将文档导出为 Markdown 推送到单一远端（LocalFS / S3 / WebDAV）。这是内容归档，不含 block ID、引用、标签与向量。同名文档使用带 ID 的文件名，删除会清理归档清单管理的陈旧文件。
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {adapters.map((a) => {
              const isSelected = form.kind === a.kind
              const isActive = status?.configured && status.adapterName === a.kind
              
              let displayName = a.label.replace(/\s*\(?Markdown\s*归档\)?\s*$/i, '')
              if (a.kind === 'localfs') displayName = '本地文件'
              else if (a.kind === 's3') displayName = 'S3 兼容'
              else if (a.kind === 'webdav') displayName = 'WebDAV'

              return (
                <button
                  key={a.kind}
                  type="button"
                  onClick={() => {
                    if (a.status !== 'available') return
                    if (a.kind === 'localfs') setForm({ ...EMPTY_LOCALFS })
                    else if (a.kind === 's3') setForm({ ...EMPTY_S3 })
                    else if (a.kind === 'webdav') setForm({ ...EMPTY_WEBDAV })
                  }}
                  disabled={a.status !== 'available'}
                  className={`flex flex-col gap-1.5 px-3 py-3 rounded-lg border text-left transition-all ${
                    isSelected
                      ? 'border-foreground bg-accent/40 shadow-sm'
                      : 'border-border bg-card hover:border-foreground/30'
                  } ${a.status !== 'available' ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <div className="flex items-center justify-between w-full">
                    <div className="flex items-center gap-2">
                      {a.kind === 'localfs' ? (
                        <FolderOpen className={`w-4 h-4 ${isSelected ? 'text-foreground' : 'text-muted-foreground'}`} />
                      ) : a.kind === 'webdav' ? (
                        <HardDrive className={`w-4 h-4 ${isSelected ? 'text-foreground' : 'text-muted-foreground'}`} />
                      ) : (
                        <Cloud className={`w-4 h-4 ${isSelected ? 'text-foreground' : 'text-muted-foreground'}`} />
                      )}
                      <span className={`font-medium text-[13px] ${isSelected ? 'text-foreground' : 'text-foreground/80'}`}>
                        {displayName}
                      </span>
                    </div>
                    {isActive && (
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]" title="当前启用"></span>
                    )}
                  </div>
                  <span className={`text-[10px] uppercase tracking-wider ${isSelected ? 'text-foreground/70' : 'text-muted-foreground/70'}`}>
                    {a.status === 'available' ? '可用' : '计划中'}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="space-y-4 pt-4 border-t border-border/40">
          {form.kind === 'localfs' && (
            <div className="grid grid-cols-1 gap-y-4 pt-2">
              <InlineField
                label="导出目录"
                description="绝对路径"
                value={form.dir}
                onChange={(v) => setForm({ ...form, dir: v })}
                placeholder="/path/to/your/notes"
                mono
              />
              <InlineField
                label="文件名前缀"
                description="可选"
                value={form.prefix ?? ''}
                onChange={(v) => setForm({ ...form, prefix: v })}
                placeholder="notes/"
                mono
              />
            </div>
          )}

          {form.kind === 's3' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4 pt-2">
              <InlineField
                label="Bucket"
                value={form.bucket}
                onChange={(v) => setForm({ ...form, bucket: v })}
                placeholder="my-notefast-bucket"
                mono
              />
              <InlineField
                label="Region"
                value={form.region}
                onChange={(v) => setForm({ ...form, region: v })}
                placeholder="us-east-1"
                mono
              />
              <InlineField
                label="Endpoint"
                description="MinIO / R2 / OSS 等兼容协议必填"
                value={form.endpoint ?? ''}
                onChange={(v) => setForm({ ...form, endpoint: v })}
                placeholder="https://s3.amazonaws.com"
                mono
              />
              <InlineField
                label="Key 前缀"
                value={form.prefix ?? ''}
                onChange={(v) => setForm({ ...form, prefix: v })}
                placeholder="notes/"
                mono
              />
              <InlineField
                label="Access Key ID"
                value={form.accessKeyId}
                onChange={(v) => setForm({ ...form, accessKeyId: v })}
                placeholder="AKIA..."
                mono
              />
              <InlineField
                label="Secret Access Key"
                value={form.secretAccessKey}
                onChange={(v) => setForm({ ...form, secretAccessKey: v })}
                placeholder="••••••••"
                type="password"
                mono
              />
              <div className="md:col-span-2 pt-2">
                <label className="flex items-center gap-2 text-[13px] text-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.forcePathStyle}
                    onChange={(e) => { setForm({ ...form, forcePathStyle: e.target.checked }) }}
                    className="rounded border-border"
                  />
                  <div className="flex flex-col">
                    <span>Path-style endpoint</span>
                    <span className="text-[11px] text-muted-foreground/60">MinIO 必需，AWS / R2 默认关闭</span>
                  </div>
                </label>
              </div>
            </div>
          )}

          {form.kind === 'webdav' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4 pt-2">
              <div className="md:col-span-2 text-[11.5px] text-muted-foreground/80 leading-relaxed bg-accent/20 p-2.5 rounded border border-border/30">
                支持 NextCloud / ownCloud / 群晖 / 坚果云等 WebDAV。第一次推送时前缀不存在会创建中间目录。
              </div>
              <div className="md:col-span-2">
                <InlineField
                  label="Endpoint URL"
                  value={form.endpoint}
                  onChange={(v) => setForm({ ...form, endpoint: v })}
                  placeholder="https://nas.local/dav/"
                  mono
                />
              </div>
              <InlineField
                label="用户名"
                value={form.username}
                onChange={(v) => setForm({ ...form, username: v })}
                mono
              />
              <InlineField
                label="密码 / 应用密码"
                value={form.password}
                onChange={(v) => setForm({ ...form, password: v })}
                placeholder="••••••••"
                type="password"
                mono
              />
              <InlineField
                label="远端子目录前缀（可选）"
                value={form.prefix ?? ''}
                onChange={(v) => setForm({ ...form, prefix: v })}
                placeholder="notes/"
                mono
              />
            </div>
          )}

          {form.kind !== 'none' && (
            <div className="pt-2">
              <InlineField
                label="自动同步间隔"
                description="单位：秒，设为 0 表示仅手动同步"
                value={String(interval)}
                type="number"
                onChange={(v) => setInterval(parseInt(v, 10) || 0)}
                mono
              />
            </div>
          )}

          {form.kind !== 'none' && (
            <div className="flex items-center gap-3 pt-4 border-t border-border/40">
              <ActionButton
                before={() => {
                  if (form.kind === 'localfs' && !form.dir.trim()) {
                    toast.warning({ title: '请输入本地导出目录绝对路径' })
                    return false
                  }
                  return true
                }}
                onAction={handleSave}
                successToast={{ title: status?.configured && status.adapterName === form.kind ? '归档配置已保存' : '归档已启用' }}
                errorToast={(e) => ({ title: '保存失败', description: e instanceof Error ? e.message : String(e) })}
              >
                {status?.configured && status.adapterName === form.kind ? '保存更改' : `启用 ${form.kind === 'localfs' ? '本地' : form.kind === 's3' ? 'S3' : 'WebDAV'} 归档`}
              </ActionButton>
              {status?.configured && status.adapterName === form.kind ? (
                <>
                  <ActionButton
                    variant="secondary"
                    onAction={handleRun}
                    successToast={{ title: '归档完成' }}
                    errorToast={(e) => ({ title: '归档失败', description: e instanceof Error ? e.message : String(e) })}
                  >
                    <RefreshCw className="w-4 h-4 mr-1.5" strokeWidth={1.75} />
                    立即同步
                  </ActionButton>
                  <ActionButton
                    variant="secondary"
                    onAction={handleInfo}
                  >
                    探测远端
                  </ActionButton>
                  <div className="w-px h-4 bg-border mx-1"></div>
                  <ActionButton
                    variant="ghost"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    onAction={() => setShowDisableConfirm(true)}
                  >
                    禁用归档
                  </ActionButton>
                </>
              ) : null}
              {status?.configured && status.adapterName !== form.kind && (
                <span className="text-[12px] text-muted-foreground ml-2">
                  注意：启用将会替换当前使用的 {status.adapterName} 适配器。
                </span>
              )}
            </div>
          )}
        </div>

        {(status?.lastRunAt || status?.lastResult || info) && (
          <div className="text-[12.5px] text-muted-foreground pt-4 border-t border-border/40 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">上次归档：</span>
              <span className="font-mono">{status?.lastRunAt || '尚未运行'}</span>
            </div>
            {status?.lastSuccessAt && status.lastResult && (
              <div className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" />
                成功上传 {status.lastResult.pushed} 个文档
              </div>
            )}
            {status?.lastError && (
              <div className="text-destructive flex items-start gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span className="break-all">{status.lastError}</span>
              </div>
            )}
            {status?.lastResult?.errors && status.lastResult.errors.length > 0 && (
              <ul className="list-disc pl-4 space-y-0.5 text-destructive/90 text-[11.5px] mt-1">
                {status.lastResult.errors.slice(0, 5).map((err) => (
                  <li key={err} className="break-all">{err}</li>
                ))}
              </ul>
            )}

            {info && (
              <div className="mt-3 bg-accent/20 p-3 rounded-lg border border-border/30 space-y-1 text-[11.5px]">
                {typeof info.remoteDocCount === 'number' && (
                  <div>远端 .md 文件数：<span className="font-mono font-medium text-foreground ml-1">{info.remoteDocCount}</span></div>
                )}
                {Object.entries(info.extra).map(([k, v]) => (
                  <div key={k}>{k}：<span className="font-mono ml-1">{String(v)}</span></div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

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
    </SettingsCard>
  )
}
