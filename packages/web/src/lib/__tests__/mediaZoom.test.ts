import { describe, test, expect } from 'bun:test'
import { fitScale, clampUserZoom, applySvgZoomFill, MEDIA_ZOOM_MIN, MEDIA_ZOOM_MAX } from '../mediaZoom'

describe('fitScale', () => {
  test('小图放大铺满视口（不再 cap 在 1×）', () => {
    // 312×245 的 mermaid 在 1400×900 灯箱里约 3× 才接近阅读区观感
    const s = fitScale(312, 245, 1400, 900)
    expect(s).toBeGreaterThan(2.5)
    expect(s).toBeLessThan(4)
  })

  test('大图缩小以适配视口', () => {
    const s = fitScale(4000, 3000, 1000, 800)
    expect(s).toBeLessThan(1)
    expect(s).toBeGreaterThan(0.2)
  })

  test('非法尺寸回退 1', () => {
    expect(fitScale(0, 100, 800, 600)).toBe(1)
    expect(fitScale(100, 100, 0, 600)).toBe(1)
  })
})

describe('clampUserZoom', () => {
  test('夹在最小/最大倍率之间', () => {
    expect(clampUserZoom(0.01)).toBe(MEDIA_ZOOM_MIN)
    expect(clampUserZoom(99)).toBe(MEDIA_ZOOM_MAX)
    expect(clampUserZoom(1)).toBe(1)
  })
})

describe('applySvgZoomFill', () => {
  test('用 !important 覆盖 mermaid 钉死的 max-width', () => {
    const calls: [string, string, string][] = []
    const style = {
      setProperty(name: string, value: string, priority = '') {
        calls.push([name, value, priority])
      },
    } as CSSStyleDeclaration
    applySvgZoomFill(style)
    expect(calls).toEqual([
      ['max-width', 'none', 'important'],
      ['max-height', 'none', 'important'],
      ['width', '100%', 'important'],
      ['height', '100%', 'important'],
    ])
  })
})
