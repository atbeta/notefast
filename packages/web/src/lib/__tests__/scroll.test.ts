import { describe, test, expect, afterEach } from 'bun:test'
import { smoothScrollTo } from '../scroll'

const prevMatchMedia = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia')

function stubReduced(on: boolean) {
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: on && query.includes('prefers-reduced-motion: reduce'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
  })
}

afterEach(() => {
  if (prevMatchMedia) Object.defineProperty(globalThis, 'matchMedia', prevMatchMedia)
  else delete (globalThis as { matchMedia?: typeof matchMedia }).matchMedia
})

describe('smoothScrollTo', () => {
  test('减弱动态效果时瞬时落地', () => {
    stubReduced(true)
    const container = { scrollTop: 0 } as HTMLElement
    smoothScrollTo(container, 240, 260)
    expect(container.scrollTop).toBe(240)
  })

  test('duration<=0 时瞬时落地', () => {
    stubReduced(false)
    const container = { scrollTop: 10 } as HTMLElement
    smoothScrollTo(container, 80, 0)
    expect(container.scrollTop).toBe(80)
  })
})
