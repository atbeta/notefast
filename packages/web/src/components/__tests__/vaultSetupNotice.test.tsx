/**
 * 「vault 是唯一形态」引导页渲染契约（RFC 0006）
 *
 * 两种文案必须区分清楚：旧库有数据（给导出 + 迁移三步）vs 空库（给怎么指定文件夹）。
 * 纯展示组件，SSR 渲染无 DOM 依赖。
 */
import { describe, test, expect } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import VaultSetupNotice from '../VaultSetupNotice'
import i18next from '../../i18n'

function render(props: { docCount: number; onExport?: () => void; exporting?: boolean }) {
  return renderToStaticMarkup(
    createElement(VaultSetupNotice, {
      docCount: props.docCount,
      onExport: props.onExport,
      exporting: props.exporting,
      onDismiss: () => {},
    }),
  )
}

describe('VaultSetupNotice', () => {
  test('旧库有数据：说明篇数、给导出按钮与迁移三步', () => {
    const html = render({ docCount: 42, onExport: () => {} })
    expect(html).toContain(i18next.t('vaultSetup.title'))
    expect(html).toContain(i18next.t('vaultSetup.legacySubtitle', { n: 42 }))
    expect(html).toContain(i18next.t('vaultSetup.legacyIntro'))
    for (const key of ['step1', 'step2', 'step3'] as const) {
      expect(html).toContain(i18next.t(`vaultSetup.${key}`))
    }
    expect(html).toContain('data-vault-setup="export"')
    expect(html).toContain(i18next.t('vaultSetup.exportNow'))
  })

  test('空库：给「怎么指定文件夹」三步，不带导出按钮', () => {
    const html = render({ docCount: 0, onExport: () => {} })
    expect(html).toContain(i18next.t('vaultSetup.freshSubtitle'))
    expect(html).toContain(i18next.t('vaultSetup.freshIntro'))
    for (const key of ['fresh1', 'fresh2', 'fresh3'] as const) {
      expect(html).toContain(i18next.t(`vaultSetup.${key}`))
    }
    // 空库没什么可导出的
    expect(html).not.toContain('data-vault-setup="export"')
    expect(html).not.toContain(i18next.t('vaultSetup.legacyIntro'))
  })

  test('没有 onExport 实现时也不渲染按钮（不给点了没反应的按钮）', () => {
    const html = render({ docCount: 7 })
    expect(html).not.toContain('data-vault-setup="export"')
  })

  test('导出中：按钮进入 loading（禁用，避免重复点）', () => {
    const html = render({ docCount: 7, onExport: () => {}, exporting: true })
    expect(html).toContain('data-vault-setup="export"')
    // React SSR 渲染成 disabled=""：匹配属性名后跟 = / 空白 / >
    expect(/\sdisabled(?:=|[\s>])/.test(html)).toBe(true)
  })

  test('永远留「暂时继续用数据库模式」的出口（Docker 没挂载的人不该被挡住）', () => {
    for (const count of [0, 5]) {
      const html = render({ docCount: count, onExport: () => {} })
      expect(html).toContain('data-vault-setup="dismiss"')
      expect(html).toContain(i18next.t('vaultSetup.keepDbMode'))
    }
  })
})
