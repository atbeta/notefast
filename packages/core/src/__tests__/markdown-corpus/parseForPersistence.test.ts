import { describe, expect, test } from 'bun:test'
import { parseMarkdownToBlocks, parseMarkdownToBlocksLegacy } from '../../markdown'
import { parseMarkdownForPersistence } from '../../markdown/parseForPersistence'
import { firstSemanticDiff, toSemanticForest } from '../../markdown/semantics'

describe('firstSemanticDiff', () => {
  test('相同森林返回 null', () => {
    const forest = toSemanticForest(parseMarkdownToBlocks('# Hi\n\npara', 'nb'))
    expect(firstSemanticDiff(forest, forest)).toBeNull()
  })

  test('类型不同返回路径，不含正文', () => {
    const a = toSemanticForest(parseMarkdownToBlocks('hello', 'nb'))
    const b = toSemanticForest(parseMarkdownToBlocks('```\nhello\n```', 'nb'))
    expect(firstSemanticDiff(a, b)).toBe('0.type')
  })
})

describe('parseMarkdownToBlocks 默认 mdast', () => {
  test('成功样本与手写语义一致', () => {
    const md = '- [x] done\n\n```ts\nconst x = 1\n```\n'
    expect(toSemanticForest(parseMarkdownToBlocks(md, 'nb'))).toEqual(
      toSemanticForest(parseMarkdownToBlocksLegacy(md, 'nb')),
    )
  })

  test('未闭合围栏不再丢内容', () => {
    const forest = toSemanticForest(parseMarkdownToBlocks('```js\nconst x = 1\n', 'nb'))
    expect(forest.some((n) => n.type === 'code' && n.content.includes('const x = 1'))).toBe(true)
  })
})

describe('parseMarkdownForPersistence', () => {
  test('默认写 mdast（tilde 围栏成为 code）', () => {
    const md = '~~~\ncode\n~~~\n'
    const forest = toSemanticForest(parseMarkdownForPersistence(md, 'nb'))
    expect(forest).toEqual([{ type: 'code', content: 'code', properties: {}, children: [] }])
  })

  test('legacy 模式仍写入手写结果', () => {
    const md = '~~~\ncode\n~~~\n'
    expect(toSemanticForest(parseMarkdownForPersistence(md, 'nb', { mode: 'legacy' }))).toEqual(
      toSemanticForest(parseMarkdownToBlocksLegacy(md, 'nb')),
    )
  })

  test('shadow 写 mdast，成功样本 match', () => {
    const md = '第一行\n第二行\n\n下一段。\n'
    const reports: Array<{ match: boolean; firstDiff?: string }> = []
    const out = parseMarkdownForPersistence(md, 'nb', {
      mode: 'shadow',
      onShadow: (r) => reports.push(r),
    })
    expect(toSemanticForest(out)).toEqual(toSemanticForest(parseMarkdownToBlocks(md, 'nb')))
    expect(reports).toHaveLength(1)
    expect(reports[0]!.match).toBe(true)
  })

  test('shadow 在围栏样本上 mismatch，但仍写 mdast', () => {
    const md = '~~~\ncode\n~~~\n'
    const reports: Array<{ match: boolean; firstDiff?: string }> = []
    const out = parseMarkdownForPersistence(md, 'nb', {
      mode: 'shadow',
      onShadow: (r) => reports.push(r),
    })
    expect(out[0]?.type).toBe('code')
    expect(reports[0]!.match).toBe(false)
    expect(reports[0]!.firstDiff).toBe('0.type')
  })
})
