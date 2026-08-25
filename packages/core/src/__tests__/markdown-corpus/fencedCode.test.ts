/**
 * 围栏扫描与 mapper 共用 mdast；失败语料必须与保存路径识别一致。
 */

import { describe, expect, test } from 'bun:test'
import { findFencedCodeSpans } from '../../markdown/fencedCode'
import { readFixtureFile } from './loadFixture'

describe('findFencedCodeSpans', () => {
  test('反引号 mermaid 围栏：区间含开闭行，value 为内部文本', () => {
    const markdown = readFixtureFile('success', '16-mermaid.md')
    const spans = findFencedCodeSpans(markdown)
    expect(spans).toHaveLength(1)
    expect(spans[0]?.language).toBe('mermaid')
    expect(spans[0]?.closed).toBe(true)
    expect(spans[0]?.from).toBe(0)
    expect(spans[0]?.to).toBe(markdown.trimEnd().length)
    expect(spans[0]?.value).toBe('graph TD\n  A-->B')
  })

  test('~~~ 围栏与反引号同等识别', () => {
    const markdown = readFixtureFile('failure', 'tilde-fence.md')
    const spans = findFencedCodeSpans(markdown)
    expect(spans).toHaveLength(1)
    expect(spans[0]?.closed).toBe(true)
    expect(spans[0]?.value).toBe('code')
  })

  test('较长开围栏内的较短 ``` 不提前闭合', () => {
    const markdown = readFixtureFile('failure', 'four-backtick.md')
    const spans = findFencedCodeSpans(markdown)
    expect(spans).toHaveLength(1)
    expect(spans[0]?.language).toBe('md')
    expect(spans[0]?.closed).toBe(true)
    expect(spans[0]?.value).toContain('```js')
    expect(spans[0]?.value).toContain('code')
  })

  test('三反引号围栏内较短的 ``` 行不当闭围栏', () => {
    const markdown = readFixtureFile('failure', 'inner-fence.md')
    const mermaidOrJs = findFencedCodeSpans(markdown).filter((s) => s.language === 'js' && s.closed)
    expect(mermaidOrJs).toHaveLength(0)
    const outer = findFencedCodeSpans(markdown).find((s) => s.language === 'md' && s.closed)
    expect(outer?.value).toContain('```js')
    expect(outer?.value).toContain('code')
  })

  test('未闭合围栏延伸到文末，标记 closed=false', () => {
    const markdown = readFixtureFile('failure', 'unclosed-fence.md')
    const spans = findFencedCodeSpans(markdown)
    expect(spans.some((s) => s.value.includes('const x = 1') && !s.closed)).toBe(true)
  })

  test('段落后未闭合围栏不吞掉前文', () => {
    const markdown = readFixtureFile('failure', 'unclosed-fence-after-para.md')
    const spans = findFencedCodeSpans(markdown)
    expect(spans).toHaveLength(1)
    expect(spans[0]?.from).toBeGreaterThan(0)
    expect(spans[0]?.closed).toBe(false)
    expect(spans[0]?.value).toContain('const x = 1')
  })
})
