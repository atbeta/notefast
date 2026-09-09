/**
 * DataModeSection 渲染契约（RFC 0005 U-1）
 *
 * 纯展示组件：SSR 渲染，断言与语言无关，只看结构、路径与开关。
 */
import { describe, test, expect } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DataModeSection } from '../LocalDataPanel'
import i18next from '../../i18n'

describe('DataModeSection', () => {
  test('db 模式：标明数据库权威，不显示笔记文件夹', () => {
    const html = renderToStaticMarkup(
      createElement(DataModeSection, { mode: 'db', vaultRoot: null }),
    )
    expect(html).toContain(i18next.t('settings.localData.modeDb'))
    expect(html).toContain(i18next.t('settings.localData.modeDbHint'))
    expect(html).not.toContain(i18next.t('settings.localData.vaultRootLabel'))
  })

  test('vault 模式：显示文件夹权威与路径', () => {
    const html = renderToStaticMarkup(
      createElement(DataModeSection, { mode: 'vault', vaultRoot: '/Users/me/Notes' }),
    )
    expect(html).toContain(i18next.t('settings.localData.modeVault'))
    expect(html).toContain('/Users/me/Notes')
    expect(html).toContain(i18next.t('settings.localData.vaultRootLabel'))
  })

  test('vault 模式但服务端未给路径：只说明权威，不渲染空路径', () => {
    const html = renderToStaticMarkup(
      createElement(DataModeSection, { mode: 'vault', vaultRoot: null }),
    )
    expect(html).toContain(i18next.t('settings.localData.modeVault'))
    expect(html).not.toContain(i18next.t('settings.localData.vaultRootLabel'))
  })
})
