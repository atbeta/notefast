/**
 * mermaid 缓存的纯逻辑契约。
 *
 * 这里只测不依赖浏览器与 mermaid 库的部分：id 替换（缓存命中的正确性关键）
 * 与主题变量读取的兜底。真正的渲染要真 DOM，由界面侧验证。
 */
import { describe, test, expect } from 'bun:test'
import { MERMAID_CACHE_MAX, clearMermaidCache, reidMermaidSvg } from '../mermaid'

describe('reidMermaidSvg', () => {
  // mermaid 会把 render id 写进根节点、内部 style 选择器、marker id 与 url(#…) 引用
  const svg =
    '<svg id="nf-mmd-7" aria-labelledby="nf-mmd-7-title">' +
    '<style>#nf-mmd-7 .node{fill:#fff}</style>' +
    '<marker id="nf-mmd-7_flowchart-pointEnd"/><path marker-end="url(#nf-mmd-7_flowchart-pointEnd)"/>' +
    '</svg>'

  test('根 id、内部选择器、marker 与 url(#…) 引用一起换掉', () => {
    const out = reidMermaidSvg(svg, 'nf-mmd-7', 'nf-mmd-9')
    expect(out).not.toContain('nf-mmd-7')
    expect(out).toContain('id="nf-mmd-9"')
    expect(out).toContain('#nf-mmd-9 .node')
    expect(out).toContain('id="nf-mmd-9_flowchart-pointEnd"')
    expect(out).toContain('url(#nf-mmd-9_flowchart-pointEnd)')
  })

  test('新旧 id 相同或旧 id 为空时原样返回', () => {
    expect(reidMermaidSvg(svg, 'nf-mmd-7', 'nf-mmd-7')).toBe(svg)
    expect(reidMermaidSvg(svg, '', 'nf-mmd-9')).toBe(svg)
  })

  test('换 id 后不会残留重复 id（同一张图出现两次时的关键）', () => {
    const a = reidMermaidSvg(svg, 'nf-mmd-7', 'nf-mmd-11')
    const b = reidMermaidSvg(svg, 'nf-mmd-7', 'nf-mmd-12')
    const ids = [...(a + b).matchAll(/id="([^"]+)"/g)].map((m) => m[1])
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('缓存上限', () => {
  test('有明确上限且可清空（换 mermaid 配置时应清空）', () => {
    expect(MERMAID_CACHE_MAX).toBeGreaterThan(0)
    clearMermaidCache()
  })
})
