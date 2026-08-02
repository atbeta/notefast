import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, ArrowDownToLine, ArrowUpFromLine, AlertCircle, Cloud } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { ActionButton, useToast } from './ui'
import { SettingsCard, StatusBadge, InlineField } from './settings/ui'
import LocationSelect from './LocationSelect'
import { formatIsoDateTime } from '../lib/time'

/**
 * 多端同步面板：双向增量同步（发布/拉取），引用存储连接 + 独立前缀。
 */

interface SyncProtocolState {
  publishedSeq: number
  consumedSeq: number
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
}

interface SyncDevice {
  device_id: string
  name?: string
  last_seen?: string
}

const EMPTY_STATUS: SyncProtocolStatus = {
  configured: false,
  enabled: false,
  state: { publishedSeq: 0, consumedSeq: 0, sinceSnapshot: 0 },
  pendingChanges: 0,
  running: false,
}

export default function SyncProtocolPanel() {
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
        loading: '正在移除设备…',
        success: '设备已从同步注册表移除（若仍在同步，请更换存储凭证才能真正拦截）',
        error: (e) => ({ title: '移除失败', description: e instanceof Error ? e.message : String(e) }),
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
        loading: '正在保存多端同步配置…',
        success: '多端同步配置已保存',
        error: (e) => ({ title: '保存失败', description: e instanceof Error ? e.message : String(e) }),
      },
    ).catch(() => undefined)
  }

  const doPull = async () => {
    const res = await api.post<{ mode?: string; applied?: number; mediaRestored?: number }>('/sync/protocol/pull', {})
    const detail = `模式 ${res.mode === 'full' ? '全量恢复' : '增量合并'}${(res.applied ?? 0) > 0 ? `，合并 ${res.applied} 条` : ''}${(res.mediaRestored ?? 0) > 0 ? `，拉回 ${res.mediaRestored} 张图` : ''}`
    toast.success({ title: '拉取完成', description: detail })
  }

  const doRun = async () => {
    const res = await api.post<{ published?: number }>('/sync/protocol/run', {})
    toast.success({ title: '同步完成', description: (res.published ?? 0) > 0 ? `发布 ${res.published} 条变更` : '无新变更' })
  }

  const lastRunText = status.lastSuccessAt
    ? formatIsoDateTime(status.lastSuccessAt)
    : '从未'

  return (
    <SettingsCard
      title="多端同步"
      icon={<Cloud className="w-4 h-4" strokeWidth={1.75} />}
      helpTip="与客户端共享同一份存储：本地变更自动发布，远端变更定期合并（LWW 按更新时间裁决）。复用「存储连接」+ 独立前缀。"
      statusBadge={
        <StatusBadge active={status.enabled} label={status.enabled ? '已启用' : '未配置'} />
      }
    >
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-medium text-foreground">启用多端同步</div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" className="sr-only peer" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <div className="w-9 h-5 bg-muted peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500"></div>
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4 pt-2">
          <div>
            <label className="text-[12px] font-medium text-muted-foreground uppercase tracking-wider">存储连接</label>
            <div className="mt-1.5"><LocationSelect value={locationId} onChange={setLocationId} kind="s3" /></div>
          </div>
          <InlineField
            label="前缀（目录）"
            description="同步数据存放于此前缀下"
            value={prefix}
            onChange={setPrefix}
            mono
            placeholder="sync"
          />
        </div>

        <div className="flex items-center gap-3 pt-4 border-t border-border/40">
          <ActionButton onAction={handleSave}>保存全部更改</ActionButton>
          {status.enabled && (
            <>
              <ActionButton variant="secondary" onAction={doPull} icon={<ArrowDownToLine className="w-4 h-4 mr-1.5" strokeWidth={1.75} />}>
                拉取 (恢复)
              </ActionButton>
              <ActionButton variant="secondary" onAction={doRun} icon={<ArrowUpFromLine className="w-4 h-4 mr-1.5" strokeWidth={1.75} />}>
                发布 (推送)
              </ActionButton>
            </>
          )}
          <button
            type="button"
            onClick={refresh}
            className="ml-auto p-1.5 text-muted-foreground/60 hover:text-foreground rounded-md transition-colors"
            title="刷新状态"
          >
            <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} />
          </button>
        </div>

        {status && (
          <div className="text-[12.5px] text-muted-foreground pt-4 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">状态：</span>
              {status.running ? (
                <span className="text-amber-500 flex items-center gap-1"><RefreshCw className="w-3.5 h-3.5 animate-spin" /> 同步中</span>
              ) : status.lastError ? (
                <span className="text-destructive flex items-center gap-1"><AlertCircle className="w-3.5 h-3.5" /> 同步失败</span>
              ) : (
                '空闲'
              )}
              <span className="ml-2">上次同步：<span className="font-mono">{lastRunText}</span></span>
            </div>
            <div className="flex items-center gap-2 text-[12px]">
              <span>已同步 <span className="font-mono text-foreground/80 tabular-nums">{status.state.publishedSeq}</span> 条变更</span>
              {status.pendingChanges > 0 && (
                <span className="text-amber-600/90">· {status.pendingChanges} 条待同步</span>
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
          首次拉取会从 S3 快照全量恢复到本地；日常为增量合并。此能力主要为客户端多端同步设计，Web 端可作为手动对账入口。
        </p>

        {status.enabled && devices.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-border/40">
            <h4 className="text-[11.5px] uppercase tracking-[0.08em] text-muted-foreground font-semibold">
              已连接设备
            </h4>
            <div className="space-y-2">
              {devices.map((d) => (
                <div
                  key={d.device_id}
                  className="flex items-center justify-between gap-3 px-3.5 py-2 rounded-lg border border-border/60 bg-accent/10 text-[12.5px]"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-foreground truncate">
                      {d.name || '未命名设备'}
                    </div>
                    <div className="text-muted-foreground text-[11px] mt-0.5 font-mono truncate">
                      {d.device_id.slice(0, 8)}…{d.last_seen ? ` · ${formatIsoDateTime(d.last_seen)}` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeDevice(d.device_id)}
                    className="px-2 py-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0"
                    title="移除（展示性；真实拦截需更换 S3 凭证）"
                  >
                    移除
                  </button>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground/60">
              设备注册存放在共享存储中（每设备一记录）；「移除」仅移除注册记录，已持有 S3 凭证的设备仍需更换凭证才能真正拦截。
            </p>
          </div>
        )}
      </div>

    </SettingsCard>
  )
}
