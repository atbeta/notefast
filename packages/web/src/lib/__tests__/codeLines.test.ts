import { describe, test, expect } from 'bun:test'
import { escapeHtml, splitHighlightedLines } from '../codeLines'

describe('splitHighlightedLines', () => {
  test('纯文本按换行切开', () => {
    expect(splitHighlightedLines('a\nb')).toEqual(['a', 'b'])
  })

  test('跨行 span 在断行处闭合再开启', () => {
    const html = '<span class="hljs-comment">a\nb</span>'
    expect(splitHighlightedLines(html)).toEqual([
      '<span class="hljs-comment">a</span>',
      '<span class="hljs-comment">b</span>',
    ])
  })

  test('行内多个 span 保持完整', () => {
    const html = '<span class="k">if</span> x\n<span class="k">else</span>'
    expect(splitHighlightedLines(html)).toEqual([
      '<span class="k">if</span> x',
      '<span class="k">else</span>',
    ])
  })

  test('末尾换行保留空行', () => {
    expect(splitHighlightedLines('a\n')).toEqual(['a', ''])
  })
})

describe('escapeHtml', () => {
  test('转义 <>&', () => {
    expect(escapeHtml('<div>&')).toBe('&lt;div&gt;&amp;')
  })
})
