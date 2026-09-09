/**
 * VaultPanel / DocVaultPath 渲染契约（V-402）
 *
 * 无 DOM 依赖：react-dom/server 渲染（纯展示组件，effect 不执行）。
 * 断言尽量与语言无关——测试进程的 locale 取决于运行时 navigator，
 * 不依赖具体文案，只看结构、数字与路径。
 */
import { describe, test, expect } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import VaultPanel from '../VaultPanel'
import DocVaultPath from '../DocVaultPath'
import i18next from '../../i18n'
import { formatIsoDateTime } from '../../lib/time'
import type { VaultStatus, VaultSyncFormState, VaultSyncStatus } from '../../lib/vault'

const BASE: VaultStatus = {
  enabled: true,
  root: '/Users/me/Vault',
  notebook_id: 'nb-1',
  watch: true,
  writeback: true,
  use_polling: false,
  watcher_active: true,
  reconciling: false,
  files: 12,
  last_reconcile: {
    totalFiles: 12,
    created: 1,
    updated: 2,
    unchanged: 8,
    restored: 0,
    moved: 0,
    deleted: 0,
    errors: [],
    durationMs: 42,
  },
  conflicts: { count: 0, paths: [] },
}

const SYNC: VaultSyncStatus = {
  enabled: true,
  configured: true,
  target: 's3://notefast-bucket/notefast-vault-sync/',
  prefix: 'notefast-vault-sync/',
  interval_seconds: 120,
  vault_id: 'vault-1',
  device_id: 'device-1',
  last_push_at: '2030-01-02T03:04:05.000Z',
  last_pull_at: '2030-01-02T03:04:06.000Z',
  last_error: null,
  last_push: { scanned: 12, changed: 3, uploaded_blobs: 2, tombstones: 1, touched_only: 4 },
  last_pull: {
    remote_entries: 9,
    applied: 2,
    deleted: 0,
    unchanged: 7,
    conflicts: [],
    errors: [],
  },
  tracked_files: 11,
  next_run_at: '2030-01-02T03:05:00.000Z',
  running: true,
  in_flight: false,
  foreign_sync_hints: [],
}

const SYNC_FORM: VaultSyncFormState = {
  enabled: true,
  locationId: 'loc-s3',
  localDir: '',
  prefix: 'notefast-vault-sync',
  intervalSeconds: '120',
}

interface RenderExtra {
  loading?: boolean
  error?: boolean
  rebuilding?: boolean
  onRebuild?: () => void
  syncForm?: VaultSyncFormState
  syncBusy?: boolean
  onSyncSave?: () => void
  onSyncPush?: () => void
  onSyncPull?: () => void
}

function render(status: VaultStatus | null, extra: RenderExtra = {}) {
  return renderToStaticMarkup(
    createElement(VaultPanel, {
      status,
      loading: extra.loading,
      error: extra.error,
      rebuilding: extra.rebuilding,
      onRebuild: extra.onRebuild ?? (() => {}),
      syncForm: extra.syncForm,
      onSyncFormChange: extra.syncForm ? () => {} : undefined,
      syncBusy: extra.syncBusy,
      onSyncSave: extra.onSyncSave ?? (() => {}),
      onSyncPush: extra.onSyncPush ?? (() => {}),
      onSyncPull: extra.onSyncPull ?? (() => {}),
    }),
  )
}

/** 渲染出的 disabled 属性个数（className 里的 `disabled:opacity-40` 不算） */
function disabledAttrs(html: string): number {
  return html.match(/\sdisabled(?:="")?(?=[\s>])/g)?.length ?? 0
}

/** 指定同步按钮是否禁用（按钮用 data-sync-action 定位，避免与开关/重建按钮混淆） */
function actionDisabled(html: string, action: 'save' | 'push' | 'pull'): boolean {
  const tag = html.match(new RegExp(`<button[^>]*data-sync-action="${action}"[^>]*>`))?.[0]
  if (!tag) throw new Error(`未找到同步按钮: ${action}`)
  return /\sdisabled(?:="")?(?=[\s>])/.test(tag)
}

describe('VaultPanel 可见性', () => {
  test('vault 未启用：渲染「当前为数据库模式」与切换指引，不再整体隐藏', () => {
    const html = render({ enabled: false })
    expect(html).toContain(i18next.t('settings.vault.disabledTitle'))
    expect(html).toContain(i18next.t('settings.vault.disabledHowTo'))
    expect(html).toContain(i18next.t('settings.vault.disabledDesktop'))
    expect(html).toContain(i18next.t('settings.vault.disabledDocker'))
    expect(html).not.toContain(i18next.t('settings.vault.rootLabel'))
  })

  test('状态尚未返回（null）：显示读取中，不误报为数据库模式', () => {
    const html = render(null, { loading: true })
    expect(html).toContain(i18next.t('settings.vault.loading'))
    expect(html).not.toContain(i18next.t('settings.vault.disabledTitle'))
  })

  test('状态请求失败：显示失败提示，不误报为数据库模式', () => {
    const html = render(null, { error: true })
    expect(html).toContain(i18next.t('settings.vault.loadFailed'))
    expect(html).not.toContain(i18next.t('settings.vault.disabledTitle'))
  })

  test('null 且既非加载也非失败：不渲染（避免空态误判）', () => {
    expect(render(null)).toBe('')
  })

  test('启用：渲染根目录、文件数、上次对账耗时', () => {
    const html = render(BASE)
    expect(html).toContain('/Users/me/Vault')
    expect(html).toContain('12')
    expect(html).toContain('42 ms')
  })
})

describe('VaultPanel 冲突列表', () => {
  test('冲突计数与最近冲突副本路径逐条渲染', () => {
    const paths = [
      'notes/a.notefast-conflict-20260909-101112.md',
      'inbox/b.notefast-conflict-20260909-101113.md',
    ]
    const html = render({ ...BASE, conflicts: { count: 7, paths } })
    for (const p of paths) expect(html).toContain(p)
    // 计数 7 只来自 conflicts.count（其余统计值都避开了 7）
    expect(html).toContain('7')
  })

  test('无冲突：不渲染任何冲突副本路径（只剩说明文案里的占位）', () => {
    const html = render(BASE)
    // 说明文案里出现 `.notefast-conflict-<时间>.md` 占位，真路径都带日期数字
    expect(/\.notefast-conflict-\d/.test(html)).toBe(false)
  })

  test('对账错误逐条渲染（路径 + 原因）', () => {
    const html = render({
      ...BASE,
      last_reconcile: {
        ...BASE.last_reconcile!,
        errors: [{ relPath: 'broken/note.md', error: 'EACCES' }],
      },
    })
    expect(html).toContain('broken/note.md')
    expect(html).toContain('EACCES')
  })
})

describe('VaultPanel 定时对账', () => {
  test('有 next_reconcile_at：渲染格式化后的时间', () => {
    const iso = '2030-01-02T03:04:05.000Z'
    const html = render({ ...BASE, next_reconcile_at: iso })
    // 只断言格式化结果出现，不依赖具体 locale 文案
    expect(html).toContain(formatIsoDateTime(iso))
    expect(html).not.toContain(iso)
  })

  test('未开启定时对账：不出现任何时间', () => {
    const html = render({ ...BASE, next_reconcile_at: null })
    expect(html).not.toContain('2030')
  })

  test('stat_skipped 计入统计（缺省按 0，不报错）', () => {
    const html = render({
      ...BASE,
      last_reconcile: { ...BASE.last_reconcile!, stat_skipped: 9 },
    })
    expect(html).toContain('9')
    expect(render(BASE)).toContain('42 ms')
  })
})

describe('VaultPanel 文件同步告警与运行态', () => {
  test('第三方同步痕迹：逐条展示工具名', () => {
    const html = render(
      { ...BASE, sync: { ...SYNC, foreign_sync_hints: ['Dropbox', 'Syncthing'] } },
      { syncForm: SYNC_FORM },
    )
    expect(html).toContain('Dropbox')
    expect(html).toContain('Syncthing')
  })

  test('服务端 in_flight：按钮与保存禁用（无需本地请求态）', () => {
    const html = render({ ...BASE, sync: { ...SYNC, in_flight: true } }, { syncForm: SYNC_FORM })
    expect(actionDisabled(html, 'push')).toBe(true)
    expect(actionDisabled(html, 'pull')).toBe(true)
    expect(actionDisabled(html, 'save')).toBe(true)
  })
})

describe('VaultPanel 重建按钮', () => {
  test('对账进行中（reconciling）：按钮禁用', () => {
    expect(disabledAttrs(render({ ...BASE, reconciling: true }))).toBe(1)
  })

  test('重建请求进行中（rebuilding）：按钮禁用', () => {
    expect(disabledAttrs(render(BASE, { rebuilding: true }))).toBe(1)
  })

  test('空闲：按钮可用', () => {
    expect(disabledAttrs(render(BASE))).toBe(0)
  })
})

describe('VaultPanel 文件同步（RFC 0004）', () => {
  test('未配置：显示未配置状态与目标兜底文案，推送/拉取禁用、保存可用', () => {
    const html = render(
      {
        ...BASE,
        sync: {
          ...SYNC,
          enabled: false,
          configured: false,
          target: null,
          last_push: null,
          last_pull: null,
          tracked_files: 0,
        },
      },
      { syncForm: SYNC_FORM },
    )
    expect(html).toContain(i18next.t('settings.vault.syncUnconfigured'))
    expect(html).toContain(i18next.t('settings.vault.syncTargetNone'))
    expect(html).not.toContain('s3://')
    expect(actionDisabled(html, 'save')).toBe(false)
    expect(actionDisabled(html, 'push')).toBe(true)
    expect(actionDisabled(html, 'pull')).toBe(true)
  })

  test('已配置：渲染目标、基线文件数、最近推拉时间与统计，按钮可用', () => {
    const html = render({ ...BASE, sync: SYNC }, { syncForm: SYNC_FORM })
    expect(html).toContain('s3://notefast-bucket/notefast-vault-sync/')
    expect(html).toContain(i18next.t('settings.vault.syncConfigured'))
    expect(html).toContain(i18next.t('settings.vault.syncTracked'))
    expect(html).toContain('11')
    expect(html).toContain(formatIsoDateTime(SYNC.last_push_at!))
    expect(html).toContain(formatIsoDateTime(SYNC.last_pull_at!))
    expect(html).toContain(formatIsoDateTime(SYNC.next_run_at!))
    expect(html).toContain(
      i18next.t('settings.vault.syncPushSummary', {
        scanned: 12,
        changed: 3,
        uploaded: 2,
        tombstones: 1,
        touched: 4,
      }),
    )
    expect(html).toContain(
      i18next.t('settings.vault.syncPullSummary', {
        remote: 9,
        applied: 2,
        deleted: 0,
        unchanged: 7,
      }),
    )
    // 表单回填：前缀 + 间隔
    expect(html).toContain('value="notefast-vault-sync"')
    expect(html).toContain('value="120"')
    expect(actionDisabled(html, 'save')).toBe(false)
    expect(actionDisabled(html, 'push')).toBe(false)
    expect(actionDisabled(html, 'pull')).toBe(false)
  })

  test('拉取冲突：逐条渲染冲突副本路径 + 计数', () => {
    const conflicts = [
      'notes/a.notefast-conflict-20260909-101112.md',
      'inbox/b.notefast-conflict-20260909-101113.md',
    ]
    const html = render(
      { ...BASE, sync: { ...SYNC, last_pull: { ...SYNC.last_pull!, conflicts } } },
      { syncForm: SYNC_FORM },
    )
    for (const p of conflicts) expect(html).toContain(p)
    expect(html).toContain(i18next.t('settings.vault.syncConflicts', { n: 2 }))
  })

  test('最近一次拉取没有冲突：不渲染冲突路径', () => {
    const html = render({ ...BASE, sync: SYNC }, { syncForm: SYNC_FORM })
    expect(html).toContain(i18next.t('settings.vault.syncNoConflicts'))
    expect(/\.notefast-conflict-\d/.test(html)).toBe(false)
  })

  test('推送/拉取进行中（syncBusy）：两个按钮与保存都禁用', () => {
    const html = render({ ...BASE, sync: SYNC }, { syncForm: SYNC_FORM, syncBusy: true })
    expect(actionDisabled(html, 'save')).toBe(true)
    expect(actionDisabled(html, 'push')).toBe(true)
    expect(actionDisabled(html, 'pull')).toBe(true)
    expect(html).toContain(i18next.t('settings.vault.syncRunning'))
  })

  test('最近错误与拉取错误逐条渲染', () => {
    const html = render(
      {
        ...BASE,
        sync: {
          ...SYNC,
          last_error: 'S3 403 Forbidden',
          last_pull: { ...SYNC.last_pull!, errors: ['blobs/ab/missing'] },
        },
      },
      { syncForm: SYNC_FORM },
    )
    expect(html).toContain(i18next.t('settings.vault.syncLastError'))
    expect(html).toContain('S3 403 Forbidden')
    expect(html).toContain(i18next.t('settings.vault.syncErrors'))
    expect(html).toContain('blobs/ab/missing')
  })

  test('同步服务未启动：显示未运行文案', () => {
    const html = render({ ...BASE, sync: { ...SYNC, running: false } }, { syncForm: SYNC_FORM })
    expect(html).toContain(i18next.t('settings.vault.syncServiceOff'))
  })

  test('未传 syncForm：不渲染同步区块（纯状态面板）', () => {
    const html = render({ ...BASE, sync: SYNC })
    expect(html).not.toContain('data-sync-action')
  })

  test('无 sync 块（旧服务端）：不渲染同步区块', () => {
    expect(render(BASE, { syncForm: SYNC_FORM })).not.toContain('data-sync-action')
  })
})

describe('DocVaultPath', () => {
  test('vault 文档：显示来源路径并带复制按钮', () => {
    const html = renderToStaticMarkup(createElement(DocVaultPath, { path: 'notes/sub/a.md' }))
    expect(html).toContain('notes/sub/a.md')
    expect(html).toContain('<button')
  })

  test('db notebook（无 vault_path）：不渲染', () => {
    expect(renderToStaticMarkup(createElement(DocVaultPath, { path: null }))).toBe('')
  })
})
