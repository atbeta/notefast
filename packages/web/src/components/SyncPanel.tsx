import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, FolderOpen, Cloud, CheckCircle2, AlertCircle, Settings as SettingsIcon } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { type LocalFsAdapterConfig } from '@notefast/core'
import LocationSelect from './LocationSelect'
import { useStorageLocations } from '../hooks/useStorageLocations'
import { ActionButton, useToast } from './ui'
import ConfirmDialog from './ConfirmDialog'
import { SettingsCard, InlineField, StatusBadge } from './settings/ui'
import { formatIsoDateTime } from '../lib/time'

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

/** 归档目标：本地目录 或 存储连接（S3 / WebDAV，由连接类型决定） */
type FormState =
  | { kind: 'none' }
  | LocalFsAdapterConfig
  | { kind: 'connection'; locationId: string; prefix: string; enabled: true }

const EMPTY_LOCALFS: LocalFsAdapterConfig = { kind: 'localfs', dir: '', prefix: '', enabled: true }
const EMPTY_CONNECTION = { kind: 'connection' as const, locationId: '', prefix: '', enabled: true as const }

export default function SyncPanel() {
  const [status, setStatus] = useState<SyncRuntimeStatus | null>(null)
  const [form, setForm] = useState<FormState>({ kind: 'none' })
  const [info, setInfo] = useState<{ remoteDocCount?: number; extra: Record<string, unknown> } | null>(null)
  const [showDisableConfirm, setShowDisableConfirm] = useState(false)
  const toast = useToast()
  const { locations } = useStorageLocations()

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<{ configured: boolean; status: SyncRuntimeStatus; config: { active: unknown } }>('/sync/config')
      setStatus(res.status)
      const active = res.config.active as { kind?: string; locationId?: string; prefix?: string } | null
      if (active?.kind === 'localfs') {
        const a = active as LocalFsAdapterConfig
        setForm({ ...EMPTY_LOCALFS, dir: a.dir ?? '', prefix: a.prefix ?? '' })
      } else if (active?.kind === 's3' || active?.kind === 'webdav') {
        setForm({
          ...EMPTY_CONNECTION,
          locationId: active.locationId ?? '',
          prefix: (active.prefix ?? '').replace(/\/$/, ''),
        })
      } else {
        setForm({ kind: 'none' })
      }
    } catch (e) {
      toast.error({ title: '加载归档配置失败', description: e instanceof Error ? e.message : String(e) })
    }
  }, [toast])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleSave = async () => {
    await toast.promise(
      async () => {
        // 存储连接 → 按连接类型落地为 s3 / webdav adapter 配置
        let active: unknown = form
        if (form.kind === 'connection') {
          const loc = locations.find((l) => l.id === form.locationId)
          if (!loc) throw new Error('请选择存储连接')
          active = loc.kind === 's3'
            ? { kind: 's3', locationId: form.locationId, prefix: form.prefix, enabled: true }
            : { kind: 'webdav', locationId: form.locationId, prefix: form.prefix, enabled: true }
        }
        await api.put('/sync/config', {
          active,
        })
        await refresh()
      },
      {
        loading: '正在保存归档配置…',
        success: 'Markdown 归档已保存',
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
      helpTip="把文档连同引用的图片导出为 Markdown 副本（.md + media/），便于迁移与便携阅读。仅手动触发，不含内部 ID、引用关系与标签。"
      statusBadge={<StatusBadge active={!!status?.configured} label={status?.configured ? `已启用 · ${status.adapterName === 'localfs' ? '本地目录' : status.adapterName === 'webdav' ? 'WebDAV' : 'S3 连接'}` : '未启用'} />}
    >
      <div className="space-y-6">
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {([
              { key: 'localfs', name: '本地目录', desc: '导出到服务器本地文件夹', icon: <FolderOpen className="w-4 h-4" /> },
              { key: 'connection', name: '存储连接', desc: 'S3 / WebDAV，由连接类型决定', icon: <Cloud className="w-4 h-4" /> },
            ] as const).map((opt) => {
              const isSelected = form.kind === opt.key
              const isActive = status?.configured && ((opt.key === 'localfs' && status.adapterName === 'localfs') || (opt.key === 'connection' && (status.adapterName === 's3' || status.adapterName === 'webdav')))
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => {
                    if (opt.key === 'localfs') setForm({ ...EMPTY_LOCALFS })
                    else setForm({ ...EMPTY_CONNECTION })
                  }}
                  className={`flex flex-col gap-1.5 px-3 py-3 rounded-lg border text-left transition-all ${
                    isSelected ? 'border-primary/45 bg-primary-soft shadow-sm' : 'border-border bg-card hover:border-border-strong'
                  }`}
                >
                  <div className="flex items-center justify-between w-full">
                    <div className="flex items-center gap-2">
                      <span className={`${isSelected ? 'text-primary' : 'text-muted-foreground'}`}>{opt.icon}</span>
                      <span className={`font-medium text-[13px] ${isSelected ? 'text-foreground' : 'text-foreground/80'}`}>{opt.name}</span>
                    </div>
                    {isActive && (
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]" title="当前启用"></span>
                    )}
                  </div>
                  <span className="text-[11px] text-muted-foreground/80">{opt.desc}</span>
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

          {form.kind === 'connection' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4 pt-2">
              <div className="md:col-span-2">
                <label className="text-[12px] font-medium text-muted-foreground uppercase tracking-wider">存储连接</label>
                <div className="mt-1.5">
                  <LocationSelect
                    value={form.locationId}
                    onChange={(v) => setForm({ ...form, locationId: v })}
                  />
                </div>
              </div>
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
            <p className="text-[11px] text-muted-foreground/60 pt-1">
              归档仅手动触发（界面「立即同步」或 API），不会自动推送。
            </p>
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
                {status?.configured && (form.kind === 'localfs' ? status.adapterName === 'localfs' : status.adapterName === 's3' || status.adapterName === 'webdav') ? '保存更改' : `启用 ${form.kind === 'localfs' ? '本地' : '连接'} 归档`}
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
              <span className="font-mono">{status?.lastRunAt ? formatIsoDateTime(status.lastRunAt) : '尚未运行'}</span>
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
