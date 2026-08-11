import { describe, test, expect } from 'bun:test'
import { pickActiveHeadingIndex } from '../useActiveHeading'

/**
 * pickActiveHeadingIndex 纯逻辑测试。
 * 这些用例对应旧 IntersectionObserver 实现「基本不可用」的回归场景：
 * 文档开头 / 两节之间 / 滚到底部 都必须有值，且跟随「最后一个滚过激活线的 heading」。
 * 默认激活线 72px（与 scrollToElement topOffset 一致）。
 */

describe('pickActiveHeadingIndex（文档开头）', () => {
  test('一个都没滚过 → 高亮第一个（旧实现：开头无 intersecting → null）', () => {
    // 第一节 heading 还在激活线下方（top=300），未滚过任何 heading
    expect(pickActiveHeadingIndex([300, 900, 1500])).toBe(0)
  })

  test('第一节刚好在激活线上 → 高亮第一个', () => {
    expect(pickActiveHeadingIndex([72, 800])).toBe(0)
  })

  test('第一节已在激活线上方 → 高亮第一个', () => {
    expect(pickActiveHeadingIndex([-100, 400, 1000])).toBe(0)
  })
})

describe('pickActiveHeadingIndex（滚动中）', () => {
  test('第一节滚过、第二节未到 → 高亮第一节（旧实现：带内无元素 → null）', () => {
    expect(pickActiveHeadingIndex([-200, 300, 900])).toBe(0)
  })

  test('第二节滚过 → 高亮第二节（跟随最新滚过的）', () => {
    expect(pickActiveHeadingIndex([-400, -150, 500])).toBe(1)
  })

  test('连续多节滚过 → 高亮最后一个', () => {
    expect(pickActiveHeadingIndex([-500, -300, -80, 600])).toBe(2)
  })

  test('多节同屏（都在激活线上方）→ 高亮 document order 最后一个', () => {
    expect(pickActiveHeadingIndex([-300, -280, -250])).toBe(2)
  })
})

describe('pickActiveHeadingIndex（滚到底部）', () => {
  test('全部滚过 → 高亮最后一节（旧实现：底部无 intersecting → null）', () => {
    expect(pickActiveHeadingIndex([-900, -600, -200])).toBe(2)
  })
})

describe('pickActiveHeadingIndex（边界/自定义激活线）', () => {
  test('空数组 → -1', () => {
    expect(pickActiveHeadingIndex([])).toBe(-1)
  })

  test('单节且未滚过 → 0（始终有值）', () => {
    expect(pickActiveHeadingIndex([100])).toBe(0)
  })

  test('自定义激活线生效', () => {
    // 激活线 200px：top=150 已滚过
    expect(pickActiveHeadingIndex([150, 500], 200)).toBe(0)
    // 激活线 100px：top=150 未滚过 → 高亮第一个
    expect(pickActiveHeadingIndex([150, 500], 100)).toBe(0)
    // 激活线 100px：top=90 已滚过，第二个未到
    expect(pickActiveHeadingIndex([90, 500], 100)).toBe(0)
  })
})
