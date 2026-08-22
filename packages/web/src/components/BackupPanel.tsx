import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Database,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Copy,
  Plug,
} from 'lucide-react'
import { api } from '../hooks/useAPI'
import { type BackupRuntimeStatus, type BackupRestorePoint } from '@notefast/core'
import { ActionButton, Tooltip, useToast } from './ui'
import { SettingsCard, InlineField, StatusBadge } from './settings/ui'
import LocationSelect from './LocationSelect'
import { formatIsoDateTime } from '../lib/time'

interface BackupConfig {
  enabled: boolean
  locationId: string | null
  prefix: string
  retentionDays: number
}

export default function BackupPanel() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<BackupRuntimeStatus | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [locationId, setLocationId] = useState('')
  const [prefix, setPrefix] = useState('')
  const [retentionDays, setRetentionDays] = useState(30)
  const [points, setPoints] = useState<BackupRestorePoint[]>([])
  const toast = useToast()

  const refresh = useCallback(async () => {
    const res = await api.get<{ configured: boolean; status: BackupRuntimeStatus; config: BackupConfig }>(
      '/backup/config',
    )
    setStatus(res.status)
    setEnabled(res.config.enabled)
    setLocationId(res.config.locationId ?? '')
    setPrefix((res.config.prefix ?? '').replace(/\/$/, ''))
    setRetentionDays(res.config.retentionDays || 30)
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
      toast.error({ title: t('backup.loadConfigFailed'), description: e instanceof Error ? e.message : String(e) })
    })
  }, [refresh, toast, t])

  const handleSave = async () => {
    await toast.promise(
      async () => {
        // 选了存储连接即视为「要配置备份」
        const hasLocation = Boolean(locationId)
        await api.put('/backup/config', {
          enabled: enabled || hasLocation,
          locationId: locationId || null,
          prefix,
          retentionDays,
        })
        await refresh()
      },
      {
        loading: t('backup.savingConfig'),
        success: t('backup.configSaved'),
        error: (e) => ({ title: t('backup.saveFailed'), description: e instanceof Error ? e.message : String(e) }),
      },
    ).catch(() => undefined)
  }

  const handleTest = async () => {
    await toast.promise(
      async () => {
        const r = await api.post<{ ok: boolean; error?: string }>('/backup/test', {})
        if (!r.ok) throw new Error(r.error || t('backup.connectFailed'))
      },
      {
        loading: t('backup.testingConnection'),
        success: t('backup.connectionOk'),
        error: (e) => ({ title: t('backup.connectFailed'), description: e instanceof Error ? e.message : String(e) }),
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
        loading: t('backup.creatingBackup'),
        success: t('backup.backupDone'),
        error: (e) => ({ title: t('backup.backupFailed'), description: e instanceof Error ? e.message : String(e) }),
      },
    ).catch(() => undefined)
  }

  const copyRestoreCmd = async (objectKey: string) => {
    const cmd = `bun --filter @notefast/server backup:restore -- --data-dir ./data --object-key ${objectKey} --yes`
    await navigator.clipboard.writeText(cmd)
    toast.success({ title: t('backup.copiedRestoreCmd'), description: t('backup.stopServiceFirst') })
  }

  return (
    <SettingsCard
      title={t('backup.title')}
      icon={<Database className="w-4 h-4" strokeWidth={1.75} />}
      helpTip={t('backup.helpTip')}      statusBadge={<StatusBadge active={!!status?.configured} label={status?.configured ? t('backup.enabled') : t('backup.notEnabled')} />}
    >
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-medium text-foreground">{t('backup.enableBackup')}</div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" className="sr-only peer" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <div className="w-9 h-5 bg-muted peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-transform peer-checked:bg-success"></div>
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4 pt-2">
          <div>
            <label className="text-[12px] font-medium text-muted-foreground uppercase tracking-wider">{t('backup.storageConnection')}</label>
            <div className="mt-1.5"><LocationSelect value={locationId} onChange={setLocationId} kind="s3" /></div>
          </div>
          <InlineField
            label={t('backup.prefix')}
            description={t('backup.prefixDesc')}
            value={prefix}
            onChange={setPrefix}
            mono
            placeholder="backup"
          />
          <InlineField
            label={t('backup.retentionDays')}
            value={String(retentionDays)}
            onChange={(v) => setRetentionDays(parseInt(v, 10) || 30)}
            type="number"
          />
        </div>

        <div className="flex items-center gap-3 pt-4 border-t border-border/40">
          <ActionButton onAction={handleSave}>{t('backup.saveAll')}</ActionButton>
          {status?.configured && (
            <>
              <ActionButton variant="secondary" onAction={handleTest}>
                <Plug className="w-4 h-4 mr-1.5" strokeWidth={1.75} />
                {t('backup.testConnection')}
              </ActionButton>
              <ActionButton variant="secondary" onAction={handleRun}>
                <RefreshCw className="w-4 h-4 mr-1.5" strokeWidth={1.75} />
                {t('backup.runNow')}
              </ActionButton>
            </>
          )}
        </div>

        {status && (
          <div className="text-[12.5px] text-muted-foreground pt-4 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">{t('backup.statusLabel')}</span>
              {status.running ? (
                <span className="text-warning flex items-center gap-1"><RefreshCw className="w-3.5 h-3.5 animate-spin"/> {t('backup.running', { phase: status.phase })}</span>
              ) : (
                t('backup.idle')
              )}
            </div>
            {status.lastSuccessAt && (
              <div className="text-success flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {t('backup.lastSuccess', { time: formatIsoDateTime(status.lastSuccessAt) })}
                {status.lastResult?.objectKey && (
                  <span className="font-mono ml-1 truncate max-w-[240px] text-[11.5px] opacity-80">{status.lastResult.objectKey}</span>
                )}
              </div>
            )}
            {status.lastError && (
              <div className="text-destructive flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5" />
                {t('backup.lastErrorLabel', { error: status.lastError })}
              </div>
            )}
          </div>
        )}

        {points.length > 0 && (
          <div className="space-y-3 pt-4 border-t border-border/40">
            <h4 className="text-[11.5px] uppercase tracking-[0.08em] text-muted-foreground font-semibold">
              {t('backup.recentPoints')}
            </h4>
            <div className="space-y-2 max-h-60 overflow-y-auto pr-2 custom-scrollbar">
              {points.map((p) => (
                <div
                  key={p.objectKey}
                  className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-lg border border-border/60 bg-accent/10 text-[12.5px] hover:border-border transition-colors"
                >
                  <div className="min-w-0">
                    <div className="font-mono truncate font-medium text-foreground">{formatIsoDateTime(p.createdAt)}</div>
                    <div className="text-muted-foreground truncate text-[11.5px] mt-0.5">
                      {(p.sizeBytes / 1024).toFixed(1)} KB · schema v{p.schemaVersion}
                    </div>
                  </div>
                  <Tooltip label={t('backup.copyRestoreCmdTitle')}>
                    <button
                      type="button"
                      onClick={() => copyRestoreCmd(p.objectKey)}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-accent hover:text-foreground text-muted-foreground shrink-0 transition-colors border border-transparent hover:border-border/50"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      <span>{t('backup.command')}</span>
                    </button>
                  </Tooltip>
                </div>
              ))}
            </div>
            <p className="text-[11.5px] text-muted-foreground">
              {t('backup.restoreHint1')} <code className="font-mono bg-accent/50 px-1 py-0.5 rounded-md text-[10.5px]">--dry-run</code> {t('backup.restoreHint2')}
            </p>
          </div>
        )}
      </div>
    </SettingsCard>
  )
}
