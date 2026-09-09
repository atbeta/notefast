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
import type { VaultStatus } from '../../lib/vault'

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

function render(status: VaultStatus | null, extra: { rebuilding?: boolean; onRebuild?: () => void } = {}) {
  return renderToStaticMarkup(
    createElement(VaultPanel, { status, rebuilding: extra.rebuilding, onRebuild: extra.onRebuild ?? (() => {}) }),
  )
}

/** 渲染出的 disabled 属性个数（className 里的 `disabled:opacity-40` 不算） */
function disabledAttrs(html: string): number {
  return html.match(/\sdisabled(?:="")?(?=[\s>])/g)?.length ?? 0
}

describe('VaultPanel 可见性', () => {
  test('vault 未启用：整体不渲染（设置页不出现错误墙）', () => {
    expect(render({ enabled: false })).toBe('')
  })

  test('状态尚未返回（null）：整体不渲染', () => {
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
