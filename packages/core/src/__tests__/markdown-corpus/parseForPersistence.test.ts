import { describe, expect, test } from 'bun:test'
import { parseMarkdownToBlocks } from '../../markdown'
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

describe('parseMarkdownForPersistence', () => {
  test('默认与手写 parser 同一棵语义树', () => {
    const md = '- [x] done\n\n```ts\nconst x = 1\n```\n'
    const a = toSemanticForest(parseMarkdownToBlocks(md, 'nb'))
    const b = toSemanticForest(parseMarkdownForPersistence(md, 'nb'))
    expect(b).toEqual(a)
  })

  test('shadow 仍返回手写结果，成功样本 match', () => {
    const md = '第一行\n第二行\n\n下一段。\n'
    const reports: Array<{ match: boolean; firstDiff?: string }> = []
    const out = parseMarkdownForPersistence(md, 'nb', {
      mode: 'shadow',
      onShadow: (r) => reports.push(r),
    })
    expect(toSemanticForest(out)).toEqual(toSemanticForest(parseMarkdownToBlocks(md, 'nb')))
    expect(reports).toHaveLength(1)
    expect(reports[0]!.match).toBe(true)
    expect(reports[0]!.firstDiff).toBeUndefined()
  })

  test('shadow 在围栏改善样本上 mismatch，仍写手写结果', () => {
    const md = '~~~\ncode\n~~~\n'
    const reports: Array<{ match: boolean; firstDiff?: string }> = []
    const out = parseMarkdownForPersistence(md, 'nb', {
      mode: 'shadow',
      onShadow: (r) => reports.push(r),
    })
    expect(toSemanticForest(out)).toEqual(toSemanticForest(parseMarkdownToBlocks(md, 'nb')))
    expect(reports[0]!.match).toBe(false)
    expect(reports[0]!.firstDiff).toBe('0.type')
  })
})
