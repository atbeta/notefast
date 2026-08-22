import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Database, Eraser, Loader2, RefreshCw, ScrollText, Sparkles } from 'lucide-react'
import { SettingsSection } from '../../components/settings/ui'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useApiQuery } from '../../hooks/useApiQuery'
import { api } from '../../hooks/useAPI'

interface HealthData {
  dbBytes: number | null
  walBytes: number | null
  dbPath: string | null
  tables: Record<string, number>
  pendingTombstones: number
  purgeableTombstones?: number
  retainedTombstones?: number
  lastMaintenance: {
    id: number
    ts: string
    level: string
    source: string
    message: string
    fields: Record<string, unknown> | null
  } | null
  ts: string
}

interface LogRow {
  id: number
  ts: string
  level: 'info' | 'warn' | 'error'
  source: string
  message: string
  fields: Record<string, unknown> | null
}

function formatBytes(n: number | null): string {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 设置 → 维护：数据库健康 + 维护操作 + 应用日志（用户侧不再黑盒） */
export default function SettingsMaintenance() {
  const { t } = useTranslation()
  const { data: health, refetch: refetchHealth } = useApiQuery<HealthData>(
    () => api.get('/db/health'),
    [],
  )
  const { data: logs, refetch: refetchLogs } = useApiQuery<{ logs: LogRow[] }>(
    () => api.get('/db/logs?limit=100'),
    [],
  )

  const [running, setRunning] = useState(false)
  const [vacuumOpen, setVacuumOpen] = useState(false)
  const [vacuuming, setVacuuming] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [actionMsg, setActionMsg] = useState<string | null>(null)

  const onRunMaintenance = async () => {
    if (running) return
    setRunning(true)
    setActionMsg(null)
    try {
      const r = await api.post<{ ok: boolean; durationMs: number; result?: { tombstones: { blocks: number } } }>(
        '/db/maintenance',
        {},
      )
      setActionMsg(
        r.ok
          ? t('settings.maintenance.runDone', { ms: r.durationMs, n: r.result?.tombstones.blocks ?? 0 })
          : t('settings.maintenance.runFailed'),
      )
    } catch {
      setActionMsg(t('settings.maintenance.runFailed'))
    } finally {
      setRunning(false)
      refetchHealth()
      refetchLogs()
    }
  }

  const onVacuum = async () => {
    if (vacuuming) return
    setVacuuming(true)
    setActionMsg(null)
    try {
      const r = await api.post<{ ok: boolean; durationMs: number }>('/db/vacuum', {})
      setActionMsg(r.ok ? t('settings.maintenance.vacuumDone', { ms: r.durationMs }) : t('settings.maintenance.vacuumFailed'))
    } catch {
      setActionMsg(t('settings.maintenance.vacuumFailed'))
    } finally {
      setVacuuming(false)
      setVacuumOpen(false)
      refetchHealth()
      refetchLogs()
    }
  }

  const refreshAll = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await api.get('/db/health?fresh=1')
      refetchHealth()
      refetchLogs()
    } finally {
      setRefreshing(false)
    }
  }

  const warnCount = (logs?.logs ?? []).filter((l) => l.level === 'warn' || l.level === 'error').length

  return (
    <SettingsSection id="maintenance" title={t('settings.tabs.maintenance')}>
      {/* 数据库健康 */}
      <div className="rounded-lg border border-border/60 bg-card shadow-card p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-foreground">
            <Database className="w-4 h-4" strokeWidth={1.75} />
            {t('settings.maintenance.dbHealth')}
          </div>
          <button
            type="button"
            onClick={() => void refreshAll()}
            disabled={refreshing}
            className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[12px] text-muted-foreground cursor-pointer hover:bg-accent hover:text-foreground active:bg-accent/80 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} strokeWidth={1.75} />
            {t('settings.maintenance.refresh')}
          </button>
        </div>

        <dl className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-[13px]">
          <div className="rounded-md bg-background/60 border border-border/50 p-3">
            <dt className="text-[11.5px] text-muted-foreground">{t('settings.maintenance.dbSize')}</dt>
            <dd className="mt-1 font-medium tabular-nums text-foreground">{formatBytes(health?.dbBytes ?? null)}</dd>
          </div>
          <div className="rounded-md bg-background/60 border border-border/50 p-3">
            <dt className="text-[11.5px] text-muted-foreground">{t('settings.maintenance.walSize')}</dt>
            <dd className="mt-1 font-medium tabular-nums text-foreground">{formatBytes(health?.walBytes ?? null)}</dd>
          </div>
          <div className="rounded-md bg-background/60 border border-border/50 p-3">
            <dt className="text-[11.5px] text-muted-foreground">{t('settings.maintenance.pendingTombstones')}</dt>
            <dd className="mt-1 font-medium tabular-nums text-foreground">{health?.pendingTombstones ?? 0}</dd>
            <dd className="mt-0.5 text-[11px] text-muted-foreground leading-snug">
              {t('settings.maintenance.pendingTombstonesHint', {
                purgeable: health?.purgeableTombstones ?? 0,
                retained: health?.retainedTombstones ?? 0,
              })}
            </dd>
          </div>
          <div className="rounded-md bg-background/60 border border-border/50 p-3">
            <dt className="text-[11.5px] text-muted-foreground">{t('settings.maintenance.blocks')}</dt>
            <dd className="mt-1 font-medium tabular-nums text-foreground">{health?.tables?.blocks ?? 0}</dd>
          </div>
        </dl>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void onRunMaintenance()}
            disabled={running}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[var(--radius-btn)] bg-foreground text-background text-[13px] font-medium disabled:opacity-50"
          >
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" strokeWidth={1.75} />}
            {t('settings.maintenance.runNow')}
          </button>
          <button
            type="button"
            onClick={() => setVacuumOpen(true)}
            disabled={vacuuming}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[var(--radius-btn)] border border-border bg-background text-[13px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {vacuuming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eraser className="w-4 h-4" strokeWidth={1.75} />}
            {t('settings.maintenance.vacuum')}
          </button>
          {actionMsg && <span className="text-[12.5px] text-muted-foreground">{actionMsg}</span>}
        </div>

        <p className="mt-3 text-[12px] text-muted-foreground leading-relaxed">
          {t('settings.maintenance.autoHint')}
        </p>
      </div>

      {/* 应用日志 */}
      <div className="mt-5 rounded-lg border border-border/60 bg-card shadow-card p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-foreground">
            <ScrollText className="w-4 h-4" strokeWidth={1.75} />
            {t('settings.maintenance.recentLogs')}
            {warnCount > 0 && (
              <span className="rounded-full bg-destructive/10 text-destructive text-[11px] font-medium px-2 py-0.5">
                {warnCount} {t('settings.maintenance.warnings')}
              </span>
            )}
          </div>
        </div>

        <div className="mt-3 max-h-72 overflow-y-auto rounded-md border border-border/50 bg-background/60">
          {!logs ? (
            <div className="p-4 text-[13px] text-muted-foreground">{t('settings.maintenance.logsLoading')}</div>
          ) : (logs.logs?.length ?? 0) === 0 ? (
            <div className="p-4 text-[13px] text-muted-foreground">{t('settings.maintenance.logsEmpty')}</div>
          ) : (
            <ul className="divide-y divide-border/50">
              {(logs.logs ?? []).map((l) => (
                <li key={l.id} className="flex items-start gap-2 px-3 py-2 text-[12.5px]">
                  <span
                    className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${
                      l.level === 'error' ? 'bg-destructive' : l.level === 'warn' ? 'bg-warning' : 'bg-success'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="font-medium text-foreground truncate">{l.message}</span>
                      <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">{l.ts}</span>
                    </div>
                    <div className="text-[11.5px] text-muted-foreground truncate">
                      {l.source}
                      {l.fields && Object.keys(l.fields).length > 0 ? ` · ${JSON.stringify(l.fields)}` : ''}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={vacuumOpen}
        title={t('settings.maintenance.vacuumTitle')}
        message={t('settings.maintenance.vacuumMessage')}
        confirmLabel={t('settings.maintenance.vacuumConfirm')}
        busy={vacuuming}
        onCancel={() => setVacuumOpen(false)}
        onConfirm={() => void onVacuum()}
      />
    </SettingsSection>
  )
}
