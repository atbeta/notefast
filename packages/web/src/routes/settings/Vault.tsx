/**
 * 设置 → Vault 模式：状态 / 冲突 / 重建索引（V-402）+ 文件同步（RFC 0004 P3）。
 *
 * - 只在 `GET /api/v1/vault/status` 回 `enabled: true` 时渲染面板（未启用 / 请求失败都隐藏）
 * - 服务端 `reconciling` 为真期间轮询，直到对账结束；期间重建按钮禁用
 * - 同步配置 / 手动推送拉取由本页发起，每个动作结束后重拉状态
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import VaultPanel from '../../components/VaultPanel'
import { useToast } from '../../components/ui'
import { api } from '../../hooks/useAPI'
import { useStorageLocations } from '../../hooks/useStorageLocations'
import { useVaultStatus } from '../../hooks/useVaultStatus'
import {
  canSwitchModeFromShell,
  nativeLeaveVault,
  nativePickVaultFolder,
} from '../../lib/nativeVault'
import {
  syncConfigPayload,
  syncFormFromConfig,
  syncFormFromStatus,
  type VaultFileSyncConfigView,
  type VaultPullResult,
  type VaultPushResult,
  type VaultReconcileStats,
  type VaultSyncFormState,
  type VaultSyncStatus,
} from '../../lib/vault'

/** 对账进行中的轮询间隔 */
const POLL_MS = 1500

export default function SettingsVault() {
  const { t } = useTranslation()
  const toast = useToast()
  const { data, loading, error, refetch } = useVaultStatus()
  const { locations } = useStorageLocations()
  const [rebuilding, setRebuilding] = useState(false)
  const [syncForm, setSyncForm] = useState<VaultSyncFormState>(() => syncFormFromStatus(null))
  const [syncBusy, setSyncBusy] = useState(false)
  /** 配置接口回填（比从 target 反解可靠：连接改名 / 换 bucket 也能对上） */
  const [syncConfig, setSyncConfig] = useState<VaultFileSyncConfigView | null>(null)
  const seeded = useRef(false)
  const reconciling = data?.reconciling === true

  useEffect(() => {
    if (!reconciling) return
    const timer = window.setInterval(refetch, POLL_MS)
    return () => window.clearInterval(timer)
  }, [reconciling, refetch])

  // 拉一次同步配置（旧服务端没有该端点时静默失败，回退到从状态反解）
  useEffect(() => {
    if (data?.enabled !== true) return
    let cancelled = false
    api
      .get<VaultFileSyncConfigView>('/vault/sync/config')
      .then((cfg) => {
        if (!cancelled) setSyncConfig(cfg)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [data?.enabled])

  // 首次拿到配置 / 状态时灌一次表单；之后不覆盖用户正在编辑的内容
  useEffect(() => {
    if (seeded.current) return
    if (syncConfig) {
      seeded.current = true
      setSyncForm(syncFormFromConfig(syncConfig))
      return
    }
    if (data?.sync) {
      seeded.current = true
      setSyncForm(syncFormFromStatus(data, locations))
    }
  }, [syncConfig, data, locations])

  const patchSyncForm = useCallback((patch: Partial<VaultSyncFormState>) => {
    setSyncForm((f) => ({ ...f, ...patch }))
  }, [])

  // 原生壳才有「切模式」通道（浏览器做不到：VAULT_PATH 是启动期参数，要重启引擎）
  const canSwitchMode = canSwitchModeFromShell()

  const handlePickVault = useCallback(async () => {
    try {
      await nativePickVaultFolder()
    } catch (e) {
      toast.error({
        title: t('settings.vault.modeSwitchFailed'),
        description: e instanceof Error ? e.message : String(e),
      })
    }
  }, [t, toast])

  const handleLeaveVault = useCallback(async () => {
    try {
      await nativeLeaveVault()
    } catch (e) {
      toast.error({
        title: t('settings.vault.modeSwitchFailed'),
        description: e instanceof Error ? e.message : String(e),
      })
    }
  }, [t, toast])

  const handleRebuild = useCallback(async () => {
    setRebuilding(true)
    try {
      const stats = await api.post<VaultReconcileStats>('/vault/rebuild', {})
      toast.success({
        title: t('settings.vault.rebuildDone', { ms: stats.durationMs }),
        description: t('settings.vault.rebuildResult', {
          files: stats.totalFiles,
          created: stats.created,
          updated: stats.updated,
          deleted: stats.deleted,
        }),
      })
    } catch (e) {
      toast.error({
        title: t('settings.vault.rebuildFailed'),
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setRebuilding(false)
      refetch()
    }
  }, [refetch, t, toast])

  const handleSyncSave = useCallback(async () => {
    setSyncBusy(true)
    try {
      const status = await api.put<VaultSyncStatus>(
        '/vault/sync/config',
        syncConfigPayload(syncForm),
      )
      toast.success({
        title: t('settings.vault.syncSaveDone'),
        description: status.target ?? t('settings.vault.syncTargetNone'),
      })
    } catch (e) {
      toast.error({
        title: t('settings.vault.syncSaveFailed'),
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setSyncBusy(false)
      refetch()
    }
  }, [refetch, syncForm, t, toast])

  const handleSyncPush = useCallback(async () => {
    setSyncBusy(true)
    try {
      const res = await api.post<VaultPushResult>('/vault/sync/push', {})
      toast.success({
        title: t('settings.vault.syncPushDone'),
        description: t('settings.vault.syncPushSummary', {
          scanned: res.scanned,
          changed: res.changed,
          uploaded: res.uploaded_blobs,
          tombstones: res.tombstones,
          touched: res.touched_only,
        }),
      })
    } catch (e) {
      toast.error({
        title: t('settings.vault.syncPushFailed'),
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setSyncBusy(false)
      refetch()
    }
  }, [refetch, t, toast])

  const handleSyncPull = useCallback(async () => {
    setSyncBusy(true)
    try {
      const res = await api.post<VaultPullResult>('/vault/sync/pull', {})
      const summary = t('settings.vault.syncPullSummary', {
        remote: res.remote_entries,
        applied: res.applied,
        deleted: res.deleted,
        unchanged: res.unchanged,
      })
      toast.success({
        title: t('settings.vault.syncPullDone'),
        description:
          res.conflicts.length > 0
            ? `${summary} · ${t('settings.vault.syncConflicts', { n: res.conflicts.length })}`
            : summary,
      })
    } catch (e) {
      toast.error({
        title: t('settings.vault.syncPullFailed'),
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setSyncBusy(false)
      refetch()
    }
  }, [refetch, t, toast])

  return (
    <VaultPanel
      status={data}
      loading={loading}
      error={Boolean(error)}
      rebuilding={rebuilding}
      onPickVault={canSwitchMode ? () => void handlePickVault() : undefined}
      onLeaveVault={canSwitchMode ? () => void handleLeaveVault() : undefined}
      onRebuild={() => void handleRebuild()}
      syncForm={syncForm}
      onSyncFormChange={patchSyncForm}
      onSyncSave={() => void handleSyncSave()}
      onSyncPush={() => void handleSyncPush()}
      onSyncPull={() => void handleSyncPull()}
      syncBusy={syncBusy}
    />
  )
}
