/**
 * Vault 面板（设置 → Vault 模式）。
 *
 * 纯展示：状态与动作由路由页 `routes/settings/Vault.tsx` 注入，
 * 便于用 react-dom/server 做无 DOM 的渲染契约测试。
 * vault 未启用（含状态尚未返回）时整体不渲染——设置页不出现错误墙。
 */
import { useTranslation } from 'react-i18next'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Cloud,
  FolderTree,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react'
import { Button, CopyButton, Toggle } from './ui'
import { SettingsCard, SettingsSection, InlineField, StatusBadge } from './settings/ui'
import LocationSelect from './LocationSelect'
import { formatIsoDateTime } from '../lib/time'
import {
  isVaultEnabled,
  recentConflictPaths,
  syncConflictCount,
  syncTargetLabel,
  type VaultStatus,
  type VaultSyncFormState,
} from '../lib/vault'

export interface VaultPanelProps {
  status: VaultStatus | null
  /** 状态请求进行中（用于把「未启用」与「还没回来」区分开） */
  loading?: boolean
  /** 状态请求失败（旧服务端没有该端点、或网络错误） */
  error?: boolean
  /** 重建请求进行中（服务端 `reconciling` 之外的本地态） */
  rebuilding?: boolean
  onRebuild?: () => void
  /** 原生壳里「打开文件夹为 vault…」（浏览器形态不传：切模式要重启引擎，网页做不到） */
  onPickVault?: () => void
  /** 原生壳里「回到数据库模式」（仅 vault 模式渲染） */
  onLeaveVault?: () => void
  /** 文件同步配置表单（不传则整块不渲染，保持纯状态面板） */
  syncForm?: VaultSyncFormState
  onSyncFormChange?: (patch: Partial<VaultSyncFormState>) => void
  onSyncSave?: () => void
  onSyncPush?: () => void
  onSyncPull?: () => void
  /** 保存 / 推送 / 拉取请求进行中（服务端 `sync.running` 之外的本地态） */
  syncBusy?: boolean
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

export default function VaultPanel({
  status,
  loading = false,
  error = false,
  rebuilding = false,
  onRebuild,
  onPickVault,
  onLeaveVault,
  syncForm,
  onSyncFormChange,
  onSyncSave,
  onSyncPush,
  onSyncPull,
  syncBusy = false,
}: VaultPanelProps) {
  const { t } = useTranslation()

  /** 既没有状态、也不在加载 / 失败：不渲染（避免把未知状态误判成 db 模式） */
  if (!status && !loading && !error) return null

  /**
   * 未启用 / 加载中 / 请求失败：不再整体隐藏（RFC 0005 U-1）。
   * 隐藏入口是用户「找不到 Vault 设置」的直接原因；这里改成明说当前模式与切换方式。
   */
  if (!isVaultEnabled(status)) {
    return (
      <SettingsSection id="vault" title={t('settings.tabs.vault')}>
        <SettingsCard
          title={loading || error ? t('settings.vault.title') : t('settings.vault.disabledTitle')}
          icon={<FolderTree className="w-4 h-4" strokeWidth={1.75} />}
          defaultExpanded
          collapsible={false}
          statusBadge={
            <StatusBadge
              active={false}
              label={loading ? t('settings.vault.loading') : error ? t('settings.vault.loadFailed') : undefined}
            />
          }
        >
          {loading ? (
            <p className="text-sm text-muted-foreground">{t('settings.vault.loading')}</p>
          ) : error ? (
            <p className="text-sm text-destructive">{t('settings.vault.loadFailed')}</p>
          ) : (
            <div className="space-y-5">
              <p className="text-sm text-muted-foreground leading-relaxed">
                {t('settings.vault.disabledHint')}
              </p>
              <div className="space-y-2">
                <div className="text-base font-medium text-foreground">
                  {t('settings.vault.disabledHowTo')}
                </div>
                <ul className="space-y-1.5 text-sm text-muted-foreground leading-relaxed">
                  <li>{t('settings.vault.disabledDesktop')}</li>
                  <li>{t('settings.vault.disabledDocker')}</li>
                  <li>{t('settings.vault.disabledServer')}</li>
                </ul>
              </div>
              {onPickVault && (
                <div className="space-y-2">
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    data-vault-action="pick"
                    icon={<FolderTree className="w-4 h-4" strokeWidth={1.75} />}
                    onClick={onPickVault}
                  >
                    {t('settings.vault.pickVault')}
                  </Button>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {t('settings.vault.pickVaultHint')}
                  </p>
                </div>
              )}
              <p className="text-sm text-muted-foreground leading-relaxed">
                {t('settings.vault.disabledMigration')}
              </p>
            </div>
          )}
        </SettingsCard>
      </SettingsSection>
    )
  }

  const reconciling = status.reconciling === true
  const busy = reconciling || rebuilding
  const stats = status.last_reconcile ?? null
  const conflictCount = status.conflicts?.count ?? 0
  const conflictPaths = recentConflictPaths(status)
  const sync = status.sync ?? null
  const showSync = Boolean(sync && syncForm)
  /**
   * 同步动作（保存 / 推送 / 拉取）的禁用条件：
   * 本地请求态（syncBusy）或服务端报告的一次运行（in_flight）。
   * 注意 `sync.running` 是「同步服务已启动」（vault 模式下恒为真），不能用来禁用。
   */
  const syncLocked = syncBusy || sync?.in_flight === true
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

          {onLeaveVault && (
            <div className="space-y-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-vault-action="leave"
                onClick={onLeaveVault}
              >
                {t('settings.vault.leaveVault')}
              </Button>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {t('settings.vault.leaveVaultHint')}
              </p>
            </div>
          )}

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
          {status.polling_auto === true && (
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t('settings.vault.pollingAuto')}
            </p>
          )}
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

          {/* 文件同步（RFC 0004 阶段 P3） */}
          {showSync && syncForm && sync && (
            <div className="rounded-md border border-border/50 bg-background/60 p-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Cloud className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />
                  <span className="text-base font-medium text-foreground">
                    {t('settings.vault.syncTitle')}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {syncBusy && (
                    <span className="text-xs text-warning inline-flex items-center gap-1">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      {t('settings.vault.syncRunning')}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {sync.running
                      ? t('settings.vault.syncServiceOn')
                      : t('settings.vault.syncServiceOff')}
                  </span>
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
                      sync.configured
                        ? 'bg-success-soft text-success border-success/20'
                        : 'bg-muted text-muted-foreground border-border/50'
                    }`}
                  >
                    {sync.configured
                      ? t('settings.vault.syncConfigured')
                      : t('settings.vault.syncUnconfigured')}
                  </span>
                </div>
              </div>

              {/* 开关 */}
              <div className="flex items-center justify-between gap-3">
                <span className="text-base font-medium text-foreground">
                  {t('settings.vault.syncEnable')}
                </span>
                <Toggle
                  checked={syncForm.enabled}
                  disabled={syncLocked}
                  onChange={(v) => onSyncFormChange?.({ enabled: v })}
                />
              </div>

              {/* 双重同步告警（RFC 0004 §已知坑） */}
              {(sync.foreign_sync_hints ?? []).length > 0 && (
                <p className="text-sm text-warning leading-relaxed">
                  {t('settings.vault.syncForeignHints', { tools: (sync.foreign_sync_hints ?? []).join(' / ') })}
                </p>
              )}

              {/* 当前目标 */}
              <div className="space-y-1.5">
                <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                  {t('settings.vault.syncTarget')}
                </div>
                <code className="block text-sm break-all rounded-md border border-border bg-background px-3 py-2 text-foreground">
                  {syncTargetLabel(status) ?? t('settings.vault.syncTargetNone')}
                </code>
              </div>

              {/* 目标配置 */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
                <div>
                  <label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                    {t('settings.vault.syncStorage')}
                  </label>
                  <div className="mt-1.5">
                    <LocationSelect
                      value={syncForm.locationId}
                      onChange={(id) => onSyncFormChange?.({ locationId: id })}
                    />
                  </div>
                </div>
                <InlineField
                  label={t('settings.vault.syncLocalDir')}
                  description={t('settings.vault.syncLocalDirDesc')}
                  value={syncForm.localDir}
                  onChange={(v) => onSyncFormChange?.({ localDir: v })}
                  mono
                />
                <InlineField
                  label={t('settings.vault.syncPrefix')}
                  description={t('settings.vault.syncPrefixDesc')}
                  value={syncForm.prefix}
                  onChange={(v) => onSyncFormChange?.({ prefix: v })}
                  mono
                />
                <InlineField
                  label={t('settings.vault.syncInterval')}
                  description={t('settings.vault.syncIntervalDesc')}
                  value={syncForm.intervalSeconds}
                  onChange={(v) => onSyncFormChange?.({ intervalSeconds: v })}
                  type="number"
                />
              </div>

              {/* 动作 */}
              <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-border/40">
                <Button
                  variant="primary"
                  size="sm"
                  data-sync-action="save"
                  onClick={onSyncSave}
                  disabled={syncLocked || !onSyncSave}
                >
                  {t('settings.vault.syncSave')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  data-sync-action="push"
                  onClick={onSyncPush}
                  disabled={syncLocked || !sync.configured || !onSyncPush}
                  icon={<ArrowUpFromLine className="w-3.5 h-3.5" strokeWidth={1.75} />}
                >
                  {t('settings.vault.syncPush')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  data-sync-action="pull"
                  onClick={onSyncPull}
                  disabled={syncLocked || !sync.configured || !onSyncPull}
                  icon={<ArrowDownToLine className="w-3.5 h-3.5" strokeWidth={1.75} />}
                >
                  {t('settings.vault.syncPull')}
                </Button>
              </div>

              {/* 最近一次推送 / 拉取 */}
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-base">
                <Stat label={t('settings.vault.syncTracked')} value={sync.tracked_files} />
                <Stat
                  label={t('settings.vault.syncLastPush')}
                  value={sync.last_push_at ? formatIsoDateTime(sync.last_push_at) : t('settings.vault.syncNever')}
                />
                <Stat
                  label={t('settings.vault.syncLastPull')}
                  value={sync.last_pull_at ? formatIsoDateTime(sync.last_pull_at) : t('settings.vault.syncNever')}
                />
              </dl>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {sync.next_run_at
                  ? t('settings.vault.syncNextRun', { at: formatIsoDateTime(sync.next_run_at) })
                  : t('settings.vault.syncNextRunOff')}
              </p>

              {sync.last_push && (
                <p className="text-sm text-muted-foreground">
                  {t('settings.vault.syncPushSummary', {
                    scanned: sync.last_push.scanned,
                    changed: sync.last_push.changed,
                    uploaded: sync.last_push.uploaded_blobs,
                    tombstones: sync.last_push.tombstones,
                    touched: sync.last_push.touched_only,
                  })}
                </p>
              )}
              {sync.last_pull && (
                <p className="text-sm text-muted-foreground">
                  {t('settings.vault.syncPullSummary', {
                    remote: sync.last_pull.remote_entries,
                    applied: sync.last_pull.applied,
                    deleted: sync.last_pull.deleted,
                    unchanged: sync.last_pull.unchanged,
                  })}
                </p>
              )}

              {sync.last_error && (
                <div className="text-sm text-destructive flex items-start gap-1.5">
                  <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.75} />
                  <span className="break-all">
                    {t('settings.vault.syncLastError')}
                    <span className="mx-1.5">·</span>
                    {sync.last_error}
                  </span>
                </div>
              )}

              {/* 拉取冲突副本 */}
              <div className="space-y-1">
                <div className="text-sm font-medium text-foreground">
                  {t('settings.vault.syncConflicts', { n: syncConflictCount(status) })}
                </div>
                {sync.last_pull && sync.last_pull.conflicts.length > 0 ? (
                  <ul className="space-y-0.5">
                    {sync.last_pull.conflicts.map((p) => (
                      <li key={p} className="text-sm break-all">
                        <code className="text-foreground/80">{p}</code>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t('settings.vault.syncNoConflicts')}
                  </p>
                )}
              </div>

              {sync.last_pull && sync.last_pull.errors.length > 0 && (
                <div className="space-y-1">
                  <div className="text-sm font-medium text-destructive">
                    {t('settings.vault.syncErrors')}
                  </div>
                  <ul className="space-y-0.5">
                    {sync.last_pull.errors.map((e) => (
                      <li key={e} className="text-xs text-muted-foreground break-all">
                        {e}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <p className="text-xs text-muted-foreground/70 leading-relaxed">
                {t('settings.vault.syncHint')}
              </p>
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}
