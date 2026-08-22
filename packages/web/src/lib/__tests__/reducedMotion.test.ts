import { describe, test, expect, afterEach } from 'bun:test'
import { prefersReducedMotion } from '../reducedMotion'

const prevMatchMedia = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia')

function stubMatchMedia(matches: boolean | null) {
  if (matches === null) {
    if (prevMatchMedia) Object.defineProperty(globalThis, 'matchMedia', prevMatchMedia)
    else delete (globalThis as { matchMedia?: typeof matchMedia }).matchMedia
    return
  }
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: matches && query.includes('prefers-reduced-motion: reduce'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
  })
}

afterEach(() => {
  stubMatchMedia(null)
})

describe('prefersReducedMotion', () => {
  test('无 matchMedia 时视为不减弱', () => {
    stubMatchMedia(null)
    expect(prefersReducedMotion()).toBe(false)
  })

  test('系统 reduce → true', () => {
    stubMatchMedia(true)
    expect(prefersReducedMotion()).toBe(true)
  })

  test('系统未开启 → false', () => {
    stubMatchMedia(false)
    expect(prefersReducedMotion()).toBe(false)
  })
})
