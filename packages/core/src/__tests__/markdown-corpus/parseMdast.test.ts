/**
 * mdast parser 与现行契约对照。
 * 成功样本必须与 expected.json（现行 parser 冻结）语义等价。
 * 失败样本允许改善，但不得比旧实现更丢内容。
 */

import { describe, expect, test } from 'bun:test'
import { parseMarkdownToBlocksMdast } from '../../markdown/parseMdast'
import { toSemanticForest } from '../../markdown/semantics'
import { FAILURE_FIXTURES, SUCCESS_FIXTURES } from './contract'
import { readExpected, readFixtureFile, readMeta } from './loadFixture'

describe('mdast parser：成功样本与现行契约一致', () => {
  for (const id of SUCCESS_FIXTURES) {
    test(id, () => {
      const markdown = readFixtureFile('success', `${id}.md`)
      const forest = toSemanticForest(parseMarkdownToBlocksMdast(markdown, 'corpus'))
      expect(forest).toEqual(readExpected('success', id))
    })
  }
})

describe('mdast parser：失败样本允许改善（围栏不再丢）', () => {
  for (const id of FAILURE_FIXTURES) {
    test(id, () => {
      const meta = readMeta('failure', id)
      expect(meta.allowImprove).toBe(true)
      const markdown = readFixtureFile('failure', `${id}.md`)
      const forest = toSemanticForest(parseMarkdownToBlocksMdast(markdown, 'corpus'))
      const codes = forest.filter((n) => n.type === 'code')
      const paras = forest.filter((n) => n.type === 'paragraph')

      switch (meta.defect) {
        case 'tilde_fence_not_recognized':
          expect(codes).toHaveLength(1)
          expect(codes[0]?.content).toBe('code')
          break
        case 'unclosed_fence_drops_content':
          expect(codes.some((c) => c.content.includes('const x = 1'))).toBe(true)
          break
        case 'unclosed_fence_drops_tail':
          expect(paras.some((p) => p.content === 'hello')).toBe(true)
          expect(codes.some((c) => c.content.includes('const x = 1'))).toBe(true)
          break
        case 'fence_length_not_matched':
          expect(codes).toHaveLength(1)
          expect(codes[0]?.content).toContain('```js')
          expect(codes[0]?.content).toContain('code')
          break
        case 'inner_fence_closes_early':
          expect(forest.some((n) => n.content.includes('code'))).toBe(true)
          break
        default:
          throw new Error(`未登记的失败样本缺陷：${meta.defect}`)
      }
    })
  }
})
