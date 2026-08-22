import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, FolderOpen, Cloud, CheckCircle2, AlertCircle, Download, Upload, Settings as SettingsIcon } from 'lucide-react'
import { api, fetchWithAuth } from '../hooks/useAPI'
import { parseContentDispositionFilename, deliverExport } from '../lib/download'
import { type LocalFsAdapterConfig, type SyncAdapterConfig } from '@notefast/core'
import LocationSelect from './LocationSelect'
import { useStorageLocations } from '../hooks/useStorageLocations'
import { ActionButton, Button, Tooltip, useToast, Toggle } from './ui'
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
  const { t } = useTranslation()
  const [status, setStatus] = useState<SyncRuntimeStatus | null>(null)
  const [form, setForm] = useState<FormState>({ kind: 'none' })
  const [info, setInfo] = useState<{ remoteDocCount?: number; extra: Record<string, unknown> } | null>(null)
  /** 已持久化的适配器配置（原样保留，供开关翻转 enabled 而无需重填表单） */
  const [activeConfig, setActiveConfig] = useState<SyncAdapterConfig | null>(null)
  const toast = useToast()
  const { locations } = useStorageLocations()

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<{ configured: boolean; status: SyncRuntimeStatus; config: { active: unknown } }>('/sync/config')
      setStatus(res.status)
      const active = res.config.active as { kind?: string; locationId?: string; prefix?: string } | null
      setActiveConfig((res.config.active as SyncAdapterConfig | null) ?? null)
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
      toast.error({ title: t('sync.loadConfigFailed'), description: e instanceof Error ? e.message : String(e) })
    }
  }, [toast, t])

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
          if (!loc) throw new Error(t('sync.chooseConnection'))
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
        loading: t('sync.savingConfig'),
        success: t('sync.configSaved'),
        error: (e) => ({ title: t('sync.saveFailed'), description: e instanceof Error ? e.message : String(e) }),
      },
    ).catch(() => undefined)
  }

  /** 开关：暂停/恢复归档（翻转已保存配置的 enabled，配置本身保留） */
  const handleToggleEnabled = async (next: boolean) => {
    if (!activeConfig) return
    setStatus((s) => (s ? { ...s, enabled: next } : s))
    await toast.promise(
      async () => {
        await api.put('/sync/config', { active: { ...activeConfig, enabled: next } })
        await refresh()
      },
      {
        loading: t('sync.savingConfig'),
        success: next ? t('sync.enabled') : t('sync.pausedRetainConfig'),
        error: (e) => ({ title: t('sync.saveFailed'), description: e instanceof Error ? e.message : String(e) }),
      },
    ).catch(() => undefined)
  }

  /** 整库导出存档：Tauri 壳弹「另存为」选路径；浏览器直接下载（与单文档导出一致） */
  const importRef = useRef<HTMLInputElement>(null)
  const [busyExport, setBusyExport] = useState(false)
  const [busyImport, setBusyImport] = useState(false)
  const handleExportArchive = async () => {
    setBusyExport(true)
    try {
      const res = await fetchWithAuth('/export/archive')
      if (!res.ok) {
        toast.error({ title: t('sync.exportFailed') })
        return
      }
      const blob = await res.blob()
      const filename =
        parseContentDispositionFilename(res.headers.get('Content-Disposition'))
        || 'notefast-export.zip'
      const delivery = await deliverExport(blob, filename)
      if (delivery.mode === 'saved') {
        toast.success({ title: t('sync.exportSavedTo', { path: delivery.savedPath }) })
      } else if (delivery.mode === 'downloaded') {
        toast.success({ title: t('sync.exportDone') })
      }
      // cancelled：用户主动放弃，不提示
    } catch (e) {
      toast.error({ title: t('sync.exportFailed'), description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusyExport(false)
    }
  }

  const handleImportArchiveFile = async (file: File) => {
    setBusyImport(true)
    const form = new FormData()
    form.append('file', file)
    const id = toast.loading({ title: t('sync.importing') })
    try {
      const res = await fetchWithAuth('/import/zip', { method: 'POST', body: form })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { message?: string } | null
        throw new Error(body?.message ?? t('sync.importFailed'))
      }
      const r = await res.json() as { imported: number; skipped: number; failed: number }
      toast.dismiss(id)
      toast.success({ title: t('sync.importDone', { imported: r.imported, skipped: r.skipped, failed: r.failed }) })
    } catch (e) {
      toast.dismiss(id)
      toast.error({ title: t('sync.importFailed'), description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusyImport(false)
    }
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
        title: t('sync.probeFailed'),
        description: e instanceof Error ? e.message : String(e),
      })
    }
  }

  /** 当前表单所选目标是否正是已配置的归档适配器（connection 对应 s3/webdav） */
  const formMatchesConfigured = !!status?.configured && (
    (form.kind === 'localfs' && status.adapterName === 'localfs') ||
    (form.kind === 'connection' && (status.adapterName === 's3' || status.adapterName === 'webdav'))
  )

  return (
    <SettingsCard
      title={t('sync.title')}
      icon={<SettingsIcon className="w-4 h-4" strokeWidth={1.75} />}
      helpTip={t('sync.helpTip')}
      statusBadge={<StatusBadge active={!!status?.configured} label={status?.configured ? t('sync.enabledWith', { adapter: status.adapterName === 'localfs' ? t('sync.adapterLocalfs') : status.adapterName === 'webdav' ? 'WebDAV' : t('sync.adapterS3') }) : t('sync.notEnabled')} />}
    >
      <div className="space-y-6">
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {([
              { key: 'localfs', name: t('sync.optLocalfs'), desc: t('sync.optLocalfsDesc'), icon: <FolderOpen className="w-4 h-4" /> },
              { key: 'connection', name: t('sync.optConnection'), desc: t('sync.optConnectionDesc'), icon: <Cloud className="w-4 h-4" /> },
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
                      <Tooltip label={t('sync.currentlyActive')}>
                        <span className="w-1.5 h-1.5 rounded-full bg-success shadow-[0_0_8px_rgb(var(--success)/0.55)]" />
                      </Tooltip>
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
                label={t('sync.exportDir')}
                description={t('sync.absolutePath')}
                value={form.dir}
                onChange={(v) => setForm({ ...form, dir: v })}
                placeholder="/path/to/your/notes"
                mono
              />
              <InlineField
                label={t('sync.filePrefix')}
                description={t('sync.optional')}
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
                <label className="text-[12px] font-medium text-muted-foreground uppercase tracking-wider">{t('sync.storageConnection')}</label>
                <div className="mt-1.5">
                  <LocationSelect
                    value={form.locationId}
                    onChange={(v) => setForm({ ...form, locationId: v })}
                  />
                </div>
              </div>
              <InlineField
                label={t('sync.remotePrefix')}
                value={form.prefix ?? ''}
                onChange={(v) => setForm({ ...form, prefix: v })}
                placeholder="notes/"
                mono
              />
            </div>
          )}

          {form.kind !== 'none' && (
            <p className="text-[11px] text-muted-foreground/60 pt-1">
              {t('sync.manualOnly')}
            </p>
          )}

          {activeConfig && (
            <div className="flex items-center justify-between pt-1">
              <span className="text-[13px] font-medium text-foreground">
                {status?.enabled ? t('sync.enabled') : t('sync.pausedRetainConfig')}
              </span>
              <Toggle
                checked={status?.enabled === true}
                onChange={handleToggleEnabled}
              />
            </div>
          )}

          {form.kind !== 'none' && (
            <div className="flex items-center gap-3 pt-4 border-t border-border/40">
              <ActionButton
                before={() => {
                  if (form.kind === 'localfs' && !form.dir.trim()) {
                    toast.warning({ title: t('sync.requireDir') })
                    return false
                  }
                  return true
                }}
                onAction={handleSave}
                successToast={{ title: formMatchesConfigured ? t('sync.configSaved') : t('sync.enabled') }}
                errorToast={(e) => ({ title: t('sync.saveFailed'), description: e instanceof Error ? e.message : String(e) })}
              >
                {formMatchesConfigured ? t('sync.saveChanges') : t('sync.enableAdapter', { kind: form.kind === 'localfs' ? t('sync.kindLocal') : t('sync.kindConnection') })}
              </ActionButton>
              {formMatchesConfigured ? (
                <>
                  <ActionButton
                    variant="secondary"
                    onAction={handleRun}
                    successToast={{ title: t('sync.archiveDone') }}
                    errorToast={(e) => ({ title: t('sync.archiveFailed'), description: e instanceof Error ? e.message : String(e) })}
                  >
                    <RefreshCw className="w-4 h-4 mr-1.5" strokeWidth={1.75} />
                    {t('sync.archiveNow')}
                  </ActionButton>
                  <ActionButton
                    variant="secondary"
                    onAction={handleInfo}
                  >
                    {t('sync.probeRemote')}
                  </ActionButton>
                </>
              ) : null}
              {status?.configured && !formMatchesConfigured && (
                <span className="text-[12px] text-muted-foreground ml-2">
                  {t('sync.replaceAdapter', { adapter: status.adapterName })}
                </span>
              )}
            </div>
          )}
        </div>

        {(status?.lastRunAt || status?.lastResult || info) && (
          <div className="text-[12.5px] text-muted-foreground pt-4 border-t border-border/40 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">{t('sync.lastArchive')}</span>
              <span className="font-mono">{status?.lastRunAt ? formatIsoDateTime(status.lastRunAt) : t('sync.neverRun')}</span>
            </div>
            {status?.lastSuccessAt && status.lastResult && (
              <div className="text-success flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {t('sync.pushedDocs', { n: status.lastResult.pushed })}
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
                  <div>{t('sync.remoteMdCount')}<span className="font-mono font-medium text-foreground ml-1">{info.remoteDocCount}</span></div>
                )}
                {Object.entries(info.extra).map(([k, v]) => (
                  <div key={k}>{k}：<span className="font-mono ml-1">{String(v)}</span></div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 便携副本：整库导出 / 导入（与归档推送同构的 zip，无需配置存储连接） */}
        <div className="flex items-center gap-3 pt-4 border-t border-border/40">
          <Button
            variant="secondary"
            loading={busyExport}
            disabled={busyImport}
            onClick={() => { void handleExportArchive() }}
          >
            <Download className="w-4 h-4 mr-1.5" strokeWidth={1.75} />
            {t('sync.exportArchive')}
          </Button>
          <Button
            variant="secondary"
            loading={busyImport}
            disabled={busyExport}
            onClick={() => {
              if (!busyImport) importRef.current?.click()
            }}
          >
            <Upload className="w-4 h-4 mr-1.5" strokeWidth={1.75} />
            {t('sync.importArchive')}
          </Button>
          <input
            ref={importRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleImportArchiveFile(file)
              e.target.value = ''
            }}
          />
          <span className="text-[11px] text-muted-foreground/60">
            {t('sync.exportHint')}
          </span>
        </div>
      </div>
    </SettingsCard>
  )
}
