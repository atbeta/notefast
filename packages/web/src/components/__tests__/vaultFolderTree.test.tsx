/**
 * VaultFolderTree 渲染契约（RFC 0005 U-8）
 *
 * 纯展示部分 SSR 渲染：不依赖 DOM，断言结构、计数、链接与展开态。
 */
import { describe, test, expect } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { VaultTreeRows, type VaultTreeLevel } from '../VaultFolderTree'
import i18next from '../../i18n'

const root: VaultTreeLevel = {
  path: '',
  dirs: [
    { path: 'notes', name: 'notes', files: 2, total: 5 },
    { path: 'work', name: 'work', files: 0, total: 1 },
  ],
  files: [
    { path: 'inbox.md', name: 'inbox', doc_id: 'doc-inbox' },
    { path: 'captured.md', name: 'captured', doc_id: 'doc-captured', status: 'inbox' },
    { path: 'old.md', name: 'old', doc_id: 'doc-old', status: 'archived' },
  ],
}

const notesLevel: VaultTreeLevel = {
  path: 'notes',
  dirs: [{ path: 'notes/books', name: 'books', files: 1, total: 1 }],
  files: [
    { path: 'notes/a.md', name: 'a', doc_id: 'doc-a' },
    { path: 'notes/b.md', name: 'b', doc_id: 'doc-b' },
  ],
}

function render(props: {
  level?: VaultTreeLevel
  levels?: Record<string, VaultTreeLevel | undefined>
  expanded?: string[]
  activeDir?: string | null
}) {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: ['/'] },
      createElement(VaultTreeRows, {
        path: '',
        level: props.level ?? root,
        levels: props.levels ?? {},
        expanded: new Set(props.expanded ?? []),
        activeDir: props.activeDir ?? null,
        onToggle: () => {},
      }),
    ),
  )
}

describe('VaultTreeRows', () => {
  test('根层：目录行带递归计数，文件行指向文档', () => {
    const html = render({})
    expect(html).toContain('notes')
    expect(html).toContain('work')
    expect(html).toContain('>5<') // notes 的递归计数徽标
    expect(html).toContain('data-tree-dir="notes"')
    expect(html).toContain('data-tree-file="inbox.md"')
    expect(html).toContain('/doc/doc-inbox')
  })

  test('目录行链接到该目录的过滤视图（?dir=）', () => {
    const html = render({})
    expect(html).toContain('/?dir=notes')
  })

  test('折叠时只出目录行，不出子层内容', () => {
    const html = render({ levels: { notes: notesLevel } })
    expect(html).not.toContain('data-tree-file="notes/a.md"')
    expect(html).not.toContain('data-tree-dir="notes/books"')
  })

  test('展开后递归渲染子层（子目录 + 直接文件）', () => {
    const html = render({ levels: { notes: notesLevel }, expanded: ['notes'] })
    expect(html).toContain('data-tree-dir="notes/books"')
    expect(html).toContain('data-tree-file="notes/a.md"')
    expect(html).toContain('/doc/doc-a')
  })

  test('展开但没有子层数据时：不崩，只显示目录行', () => {
    const html = render({ expanded: ['notes'] })
    expect(html).toContain('data-tree-dir="notes"')
    expect(html).not.toContain('data-tree-file="notes/a.md"')
  })

  test('当前目录高亮（?dir= 命中时给链接加 active 类）', () => {
    const active = render({ activeDir: 'notes' })
    const idle = render({ activeDir: null })
    expect(active).toContain('bg-primary-soft')
    expect(idle).not.toContain('bg-primary-soft')
  })

  test('展开按钮带 aria 状态与可访问名', () => {
    const html = render({ levels: { notes: notesLevel }, expanded: ['notes'] })
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain(i18next.t('sidebar.vaultTreeCollapse'))
    expect(render({})).toContain(i18next.t('sidebar.vaultTreeExpand'))
  })

  test('状态标记：收集箱 / 归档文件带标记，普通笔记不带', () => {
    const html = render({})
    // 采集件（根目录里和手写笔记并排）必须能一眼看出来
    expect(html).toContain('data-tree-file="captured.md"')
    expect(html).toContain('data-tree-status="inbox"')
    expect(html).toContain('data-tree-status="archived"')
    expect(html).toContain('data-tree-status="note"')
    // 标记文案复用侧栏既有 key，不新造词
    expect(html).toContain(i18next.t('sidebar.inbox'))
    expect(html).toContain(i18next.t('sidebar.archived'))
  })

  test('空目录（无子目录无文件）：只有容器，没有行', () => {
    const html = render({ level: { path: '', dirs: [], files: [] } })
    expect(html).not.toContain('data-tree-dir')
    expect(html).not.toContain('data-tree-file')
  })
})
