import { describe, expect, test } from 'bun:test'
import { shortcutGroups } from '../shortcutCatalog'

describe('shortcutGroups', () => {
  test('非文档页只有全局键', () => {
    const g = shortcutGroups({ page: 'none' })
    expect(g.local).toEqual([])
    expect(g.global.map((x) => x.id)).toContain('search')
    expect(g.global.map((x) => x.id)).not.toContain('exitDemo')
  })

  test('阅读态本页是进入编辑和查找', () => {
    const g = shortcutGroups({ page: 'doc-reading' })
    expect(g.local.map((x) => x.id)).toEqual(['enterEdit', 'find'])
    expect(g.local.some((x) => x.id === 'bold')).toBe(false)
  })

  test('编辑态不含进入编辑，含保存和格式化', () => {
    const g = shortcutGroups({ page: 'doc-editing' })
    expect(g.local.map((x) => x.id)).not.toContain('enterEdit')
    expect(g.local.map((x) => x.id)).toEqual([
      'save',
      'preview',
      'find',
      'bold',
      'italic',
      'inlineCode',
      'link',
    ])
  })

  test('Chat 已配置时编辑态追加续写键', () => {
    const g = shortcutGroups({ page: 'doc-editing', aiContinue: true })
    expect(g.local.map((x) => x.id)).toContain('aiContinue')
    expect(g.local.map((x) => x.id)).toContain('aiAccept')
  })

  test('演示中全局追加 Esc', () => {
    const g = shortcutGroups({ page: 'none', demoActive: true })
    expect(g.global.at(-1)?.id).toBe('exitDemo')
  })
})
