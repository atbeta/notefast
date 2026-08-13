import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, ArrowDownToLine, ArrowUpFromLine, AlertCircle, Cloud } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { ActionButton, Tooltip, useToast } from './ui'
import { SettingsCard, StatusBadge, InlineField } from './settings/ui'
import LocationSelect from './LocationSelect'
import { formatIsoDateTime } from '../lib/time'

/**
 * 多端同步面板：双向增量同步（发布/拉取），引用存储连接 + 独立前缀。
 */

interface SyncProtocolState {
  publishedSeq: number
  /** per-device 高水位（v2；各远端设备已消费到的 seq） */
  consumed: Record<string, number>
  sinceSnapshot: number
}

interface SyncProtocolStatus {
  configured: boolean
  enabled: boolean
  s3Bucket?: string
  s3Prefix?: string
  lastRunAt?: string
  lastSuccessAt?: string
  lastError?: string
  state: SyncProtocolState
  pendingChanges: number
  running: boolean
  /** 远端各设备增量终点 × 本端消费水位（最近一次同步读到的 manifest） */
  details?: {
    remoteDevices: Array<{ deviceId: string; lastSeq: number; consumedSeq: number }>
  }
}

interface SyncDevice {
  device_id: string
  name?: string
  last_seen?: string
}

const EMPTY_STATUS: SyncProtocolStatus = {
  configured: false,
  enabled: false,
  state: { publishedSeq: 0, consumed: {}, sinceSnapshot: 0 },
  pendingChanges: 0,
  running: false,
}

export default function SyncProtocolPanel() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<SyncProtocolStatus>(EMPTY_STATUS)
  const [devices, setDevices] = useState<SyncDevice[]>([])
  const [enabled, setEnabled] = useState(false)
  const [locationId, setLocationId] = useState('')
  const [prefix, setPrefix] = useState('')
  const toast = useToast()

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<{ configured: boolean; config: { enabled: boolean; locationId: string | null; prefix: string }; status: SyncProtocolStatus }>('/sync/protocol/config')
      setStatus(res.status)
      setEnabled(res.config.enabled)
      setLocationId(res.config.locationId ?? '')
      setPrefix((res.config.prefix ?? '').replace(/\/$/, ''))
      // 设备列表（共享存储注册表；可能因未配置/远端不可达失败，忽略）
      api.get<{ devices: SyncDevice[] }>('/sync/protocol/devices')
        .then((r) => setDevices(r.devices ?? []))
        .catch(() => setDevices([]))
    } catch {
      setStatus(EMPTY_STATUS)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const removeDevice = async (id: string) => {
    await toast.promise(
      async () => {
        await api.del(`/sync/protocol/devices/${encodeURIComponent(id)}`)
        await refresh()
      },
      {
        loading: t('syncProtocol.removingDevice'),
        success: t('syncProtocol.deviceRemoved'),
        error: (e) => ({ title: t('syncProtocol.removeFailed'), description: e instanceof Error ? e.message : String(e) }),
      },
    ).catch(() => undefined)
  }

  const handleSave = async () => {
    await toast.promise(
      async () => {
        // 选了存储连接即视为「要配置多端同步」——不受独立开关误伤
        const hasLocation = Boolean(locationId)
        await api.put('/sync/protocol/config', {
          enabled: enabled || hasLocation,
          locationId: locationId || null,
          prefix,
        })
        await refresh()
      },
      {
        loading: t('syncProtocol.savingConfig'),
        success: t('syncProtocol.configSaved'),
        error: (e) => ({ title: t('syncProtocol.saveFailed'), description: e instanceof Error ? e.message : String(e) }),
      },
    ).catch(() => undefined)
  }

  const doPull = async () => {
    const res = await api.post<{ mode?: string; applied?: number; mediaRestored?: number }>('/sync/protocol/pull', {})
    const mode = res.mode === 'full' ? t('syncProtocol.pullModeFull') : t('syncProtocol.pullModeMerge')
    const merged = (res.applied ?? 0) > 0 ? t('syncProtocol.pullMerged', { n: res.applied }) : ''
    const media = (res.mediaRestored ?? 0) > 0 ? t('syncProtocol.pullMedia', { n: res.mediaRestored }) : ''
    toast.success({ title: t('syncProtocol.pullDone'), description: t('syncProtocol.pullDetail', { mode, merged, media }) })
  }

  const doRun = async () => {
    const res = await api.post<{ published?: number }>('/sync/protocol/run', {})
    toast.success({ title: t('syncProtocol.syncDone'), description: (res.published ?? 0) > 0 ? t('syncProtocol.published', { n: res.published }) : t('syncProtocol.noChanges') })
  }

  const lastRunText = status.lastSuccessAt
    ? formatIsoDateTime(status.lastSuccessAt)
    : t('syncProtocol.never')

  /** 远端设备落后量（manifest 终点 - 本端已消费水位；未知/本端不显示） */
  const deviceLag = (deviceId: string): number => {
    const r = status.details?.remoteDevices.find((x) => x.deviceId === deviceId)
    return r ? Math.max(0, r.lastSeq - r.consumedSeq) : 0
  }

  return (
    <SettingsCard
      title={t('syncProtocol.title')}
      icon={<Cloud className="w-4 h-4" strokeWidth={1.75} />}
      helpTip={t('syncProtocol.helpTip')}
      statusBadge={
        <StatusBadge active={status.enabled} label={status.enabled ? t('syncProtocol.enabled') : t('syncProtocol.notConfigured')} />
      }
    >
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-medium text-foreground">{t('syncProtocol.enableSync')}</div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" className="sr-only peer" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <div className="w-9 h-5 bg-muted peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500"></div>
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4 pt-2">
          <div>
            <label className="text-[12px] font-medium text-muted-foreground uppercase tracking-wider">{t('syncProtocol.storageConnection')}</label>
            <div className="mt-1.5"><LocationSelect value={locationId} onChange={setLocationId} kind="s3" /></div>
          </div>
          <InlineField
            label={t('syncProtocol.prefix')}
            description={t('syncProtocol.prefixDesc')}
            value={prefix}
            onChange={setPrefix}
            mono
            placeholder="sync"
          />
        </div>

        <div className="flex items-center gap-3 pt-4 border-t border-border/40">
          <ActionButton onAction={handleSave}>{t('syncProtocol.saveAll')}</ActionButton>
          {status.enabled && (
            <>
              <ActionButton variant="secondary" onAction={doPull} icon={<ArrowDownToLine className="w-4 h-4 mr-1.5" strokeWidth={1.75} />}>
                {t('syncProtocol.pull')}
              </ActionButton>
              <ActionButton variant="secondary" onAction={doRun} icon={<ArrowUpFromLine className="w-4 h-4 mr-1.5" strokeWidth={1.75} />}>
                {t('syncProtocol.publish')}
              </ActionButton>
            </>
          )}
          <Tooltip label={t('syncProtocol.refreshStatus')}>
            <button
              type="button"
              onClick={refresh}
              className="ml-auto p-1.5 text-muted-foreground/60 hover:text-foreground rounded-md transition-colors"
              aria-label={t('syncProtocol.refreshStatus')}
            >
              <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} />
            </button>
          </Tooltip>
        </div>

        {status && (
          <div className="text-[12.5px] text-muted-foreground pt-4 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">{t('syncProtocol.statusLabel')}</span>
              {status.running ? (
                <span className="text-amber-500 flex items-center gap-1"><RefreshCw className="w-3.5 h-3.5 animate-spin" /> {t('syncProtocol.syncing')}</span>
              ) : status.lastError ? (
                <span className="text-destructive flex items-center gap-1"><AlertCircle className="w-3.5 h-3.5" /> {t('syncProtocol.syncFailed')}</span>
              ) : (
                t('syncProtocol.idle')
              )}
              <span className="ml-2">{t('syncProtocol.lastSync')}<span className="font-mono">{lastRunText}</span></span>
            </div>
            <div className="flex items-center gap-2 text-[12px]">
              <span>{t('syncProtocol.syncedChanges', { n: status.state.publishedSeq })}</span>
              {status.pendingChanges > 0 && (
                <span className="text-amber-600/90">{t('syncProtocol.pendingChanges', { n: status.pendingChanges })}</span>
              )}
            </div>
            {status.lastError && (
              <div className="text-destructive flex items-start gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{status.lastError}</span>
              </div>
            )}
          </div>
        )}

        <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
          {t('syncProtocol.hint')}
        </p>

        {status.enabled && devices.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-border/40">
            <h4 className="text-[11.5px] uppercase tracking-[0.08em] text-muted-foreground font-semibold">
              {t('syncProtocol.devices')}
            </h4>
            <div className="space-y-2">
              {devices.map((d) => (
                <div
                  key={d.device_id}
                  className="flex items-center justify-between gap-3 px-3.5 py-2 rounded-lg border border-border/60 bg-accent/10 text-[12.5px]"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-foreground truncate">
                      {d.name || t('syncProtocol.unnamedDevice')}
                    </div>
                    <div className="text-muted-foreground text-[11px] mt-0.5 font-mono truncate">
                      {d.device_id.slice(0, 8)}…{d.last_seen ? ` · ${formatIsoDateTime(d.last_seen)}` : ''}
                      {deviceLag(d.device_id) > 0 && (
                        <span className="text-amber-600/90"> · {t('syncProtocol.deviceLag', { n: deviceLag(d.device_id) })}</span>
                      )}
                    </div>
                  </div>
                  <Tooltip label={t('syncProtocol.removeTitle')}>
                    <button
                      type="button"
                      onClick={() => removeDevice(d.device_id)}
                      className="px-2 py-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0"
                    >
                      {t('syncProtocol.remove')}
                    </button>
                  </Tooltip>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground/60">
              {t('syncProtocol.deviceHint')}
            </p>
          </div>
        )}
      </div>

    </SettingsCard>
  )
}
