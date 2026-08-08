/**
 * useFocusTrap — 模态焦点循环
 *
 * 钉住「Tab/Shift+Tab 在容器内/外的 wrap 行为」契约。
 * 真实 DOM 按键事件由 React Testing Library 套件覆盖（无 DOM 环境，
 * 不强行 happy-dom，避免给 bun test 加运行时依赖）。
 */
import { describe, test, expect } from 'bun:test'
import { pickNextFocus } from '../useFocusTrap'

function makeFocusables(n: number): HTMLElement[] {
  return Array.from({ length: n }, (_, i) => ({ tag: 'BUTTON', index: i } as unknown as HTMLElement))
}

describe('pickNextFocus — Tab/Shift+Tab 循环', () => {
  test('Tab 在中间元素上不动', () => {
    const focusables = makeFocusables(3)
    const container = { contains: () => true } as unknown as HTMLElement
    expect(pickNextFocus(focusables, focusables[1], false, container)).toBeNull()
  })
  test('Tab 在最后一个 → wrap 到 first', () => {
    const focusables = makeFocusables(3)
    const container = { contains: () => true } as unknown as HTMLElement
    expect(pickNextFocus(focusables, focusables[2], false, container)).toBe(focusables[0])
  })
  test('Shift+Tab 在第一个 → wrap 到 last', () => {
    const focusables = makeFocusables(3)
    const container = { contains: () => true } as unknown as HTMLElement
    expect(pickNextFocus(focusables, focusables[0], true, container)).toBe(focusables[2])
  })
  test('焦点在容器外（背景）→ Tab 跳到 first', () => {
    const focusables = makeFocusables(3)
    const container = { contains: () => false } as unknown as HTMLElement
    const outside = {} as HTMLElement
    expect(pickNextFocus(focusables, outside, false, container)).toBe(focusables[0])
  })
  test('焦点为 null → Tab 跳到 first', () => {
    const focusables = makeFocusables(3)
    const container = { contains: () => false } as unknown as HTMLElement
    expect(pickNextFocus(focusables, null, false, container)).toBe(focusables[0])
  })
  test('单个 focusable 时 Tab 仍需 wrap 回自身', () => {
    const focusables = makeFocusables(1)
    const container = { contains: () => true } as unknown as HTMLElement
    expect(pickNextFocus(focusables, focusables[0], false, container)).toBe(focusables[0])
    expect(pickNextFocus(focusables, focusables[0], true, container)).toBe(focusables[0])
  })
  test('空容器 → 返回 null（调用方应回退聚焦到容器自身）', () => {
    const container = {} as HTMLElement
    expect(pickNextFocus([], null, false, container)).toBeNull()
  })
})