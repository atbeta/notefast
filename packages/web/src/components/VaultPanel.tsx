/**
 * Vault 面板（设置 → Vault 模式）。
 *
 * 纯展示：状态与动作由路由页 `routes/settings/Vault.tsx` 注入，
 * 便于用 react-dom/server 做无 DOM 的渲染契约测试。
 * vault 未启用（含状态尚未返回）时整体不渲染——设置页不出现错误墙。
 */
import { useTranslation } from 'react-i18next'
import { FolderTree, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import { Button, CopyButton } from './ui'
import { SettingsCard, SettingsSection, StatusBadge } from './settings/ui'
import { formatIsoDateTime } from '../lib/time'
import { isVaultEnabled, recentConflictPaths, type VaultStatus } from '../lib/vault'

export interface VaultPanelProps {
  status: VaultStatus | null
  /** 重建请求进行中（服务端 `reconciling` 之外的本地态） */
  rebuilding?: boolean
  onRebuild?: () => void
}

/** 对账统计的一格 */
function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md bg-background/60 border border-border/50 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-medium tabular-nums text-foreground">{value}</dd>
    </div>
  )
}

export default function VaultPanel({ status, rebuilding = false, onRebuild }: VaultPanelProps) {
  const { t } = useTranslation()
  if (!isVaultEnabled(status)) return null

  const reconciling = status.reconciling === true
  const busy = reconciling || rebuilding
  const stats = status.last_reconcile ?? null
  const conflictCount = status.conflicts?.count ?? 0
  const conflictPaths = recentConflictPaths(status)
  const flag = (on: boolean | undefined) =>
    on ? t('settings.vault.flagOn') : t('settings.vault.flagOff')

  return (
    <SettingsSection id="vault" title={t('settings.tabs.vault')}>
      <SettingsCard
        title={t('settings.vault.title')}
        icon={<FolderTree className="w-4 h-4" strokeWidth={1.75} />}
        helpTip={t('settings.vault.helpTip')}
        defaultExpanded
        collapsible={false}
        statusBadge={
          <StatusBadge
            active={!reconciling}
            label={reconciling ? t('settings.vault.reconciling') : undefined}
          />
        }
      >
        <div className="space-y-5">
          {/* 根目录 */}
          <div className="space-y-2">
            <div className="text-base font-medium text-foreground">{t('settings.vault.rootLabel')}</div>
            <div className="flex items-start gap-2">
              <code className="flex-1 min-w-0 text-sm break-all rounded-md border border-border bg-background px-3 py-2 text-foreground">
                {status.root ?? '—'}
              </code>
              {status.root && (
                <CopyButton
                  text={status.root}
                  ariaLabel={t('settings.vault.copyRoot')}
                  title={t('settings.vault.copyRoot')}
                  className="shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-[var(--radius-btn)] border border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground"
                />
              )}
            </div>
          </div>

          {/* 概览：文件数 + 开关位（VAULT_* 环境变量，只读） */}
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-base">
            <Stat label={t('settings.vault.files')} value={status.files ?? 0} />
            <Stat label={t('settings.vault.watch')} value={flag(status.watch)} />
            <Stat label={t('settings.vault.writeback')} value={flag(status.writeback)} />
            <Stat label={t('settings.vault.polling')} value={flag(status.use_polling)} />
          </dl>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {status.watcher_active
              ? t('settings.vault.watcherActive')
              : t('settings.vault.watcherInactive')}
          </p>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {status.next_reconcile_at
              ? t('settings.vault.nextReconcile', { at: formatIsoDateTime(status.next_reconcile_at) })
              : t('settings.vault.nextReconcileOff')}
          </p>

          {/* 最近一次对账 + 重建 */}
          <div className="rounded-md border border-border/50 bg-background/60 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-base font-medium text-foreground">
                {t('settings.vault.lastReconcile')}
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={onRebuild}
                disabled={busy || !onRebuild}
                icon={
                  busy ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} />
                  )
                }
              >
                {t('settings.vault.rebuild')}
              </Button>
            </div>

            {stats ? (
              <>
                <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-base">
                  <Stat label={t('settings.vault.totalFiles')} value={stats.totalFiles} />
                  <Stat label={t('settings.vault.created')} value={stats.created} />
                  <Stat label={t('settings.vault.updated')} value={stats.updated} />
                  <Stat label={t('settings.vault.unchanged')} value={stats.unchanged} />
                  <Stat label={t('settings.vault.restored')} value={stats.restored} />
                  <Stat label={t('settings.vault.moved')} value={stats.moved} />
                  <Stat label={t('settings.vault.deleted')} value={stats.deleted} />
                  <Stat label={t('settings.vault.statSkipped')} value={stats.stat_skipped ?? 0} />
                  <Stat label={t('settings.vault.duration')} value={`${stats.durationMs} ms`} />
                </dl>
                {stats.errors.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-sm font-medium text-destructive">
                      {t('settings.vault.errorList')}
                    </div>
                    <ul className="space-y-0.5">
                      {stats.errors.map((e) => (
                        <li key={`${e.relPath}:${e.error}`} className="text-xs text-muted-foreground break-all">
                          <code className="text-foreground/80">{e.relPath}</code>
                          <span className="mx-1.5">·</span>
                          {e.error}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t('settings.vault.noReconcile')}</p>
            )}
          </div>

          {/* 写回冲突（RFC 0003 阶段 D） */}
          <div className="rounded-md border border-border/50 bg-background/60 p-4 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <TriangleAlert
                className={`w-4 h-4 shrink-0 ${conflictCount > 0 ? 'text-warning' : 'text-muted-foreground'}`}
                strokeWidth={1.75}
              />
              <span className="text-base font-medium text-foreground">
                {t('settings.vault.conflictsTitle')}
              </span>
              <span
                className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
                  conflictCount > 0
                    ? 'bg-warning-soft text-warning border-warning/20'
                    : 'bg-muted text-muted-foreground border-border/50'
                }`}
              >
                {t('settings.vault.conflictCount', { n: conflictCount })}
              </span>
            </div>

            {conflictPaths.length > 0 ? (
              <>
                <div className="text-xs text-muted-foreground">{t('settings.vault.conflictPaths')}</div>
                <ul className="space-y-0.5">
                  {conflictPaths.map((p) => (
                    <li key={p} className="text-sm break-all">
                      <code className="text-foreground/80">{p}</code>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t('settings.vault.noConflicts')}</p>
            )}

            <p className="text-sm text-muted-foreground leading-relaxed">
              {t('settings.vault.conflictHint')}
            </p>
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}
