/**
 * 设置 → Vault 模式：状态 / 冲突 / 重建索引（V-402）。
 *
 * - 只在 `GET /api/v1/vault/status` 回 `enabled: true` 时渲染面板（未启用 / 请求失败都隐藏）
 * - 服务端 `reconciling` 为真期间轮询，直到对账结束；期间重建按钮禁用
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import VaultPanel from '../../components/VaultPanel'
import { useToast } from '../../components/ui'
import { api } from '../../hooks/useAPI'
import { useVaultStatus } from '../../hooks/useVaultStatus'
import type { VaultReconcileStats } from '../../lib/vault'

/** 对账进行中的轮询间隔 */
const POLL_MS = 1500

export default function SettingsVault() {
  const { t } = useTranslation()
  const toast = useToast()
  const { data, refetch } = useVaultStatus()
  const [rebuilding, setRebuilding] = useState(false)
  const reconciling = data?.reconciling === true

  useEffect(() => {
    if (!reconciling) return
    const timer = window.setInterval(refetch, POLL_MS)
    return () => window.clearInterval(timer)
  }, [reconciling, refetch])

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

  return (
    <VaultPanel status={data} rebuilding={rebuilding} onRebuild={() => void handleRebuild()} />
  )
}
