import { beforeEach, describe, expect, test } from 'bun:test'
import { installNativeNavigate } from '../nativeNavigate'

beforeEach(() => {
  Object.defineProperty(globalThis, 'window', {
    value: {},
    writable: true,
    configurable: true,
  })
})

describe('installNativeNavigate', () => {
  test('安装后可调用，卸载后清除', () => {
    const calls: string[] = []
    const uninstall = installNativeNavigate((path) => { calls.push(path) })
    expect(typeof window.__notefastNavigate).toBe('function')
    window.__notefastNavigate?.('/doc/abc?native=macos')
    expect(calls).toEqual(['/doc/abc?native=macos'])
    uninstall()
    expect(window.__notefastNavigate).toBeUndefined()
  })

  test('后装的导航覆盖先装的；卸载只清自己', () => {
    const a: string[] = []
    const b: string[] = []
    const unA = installNativeNavigate((path) => { a.push(path) })
    const unB = installNativeNavigate((path) => { b.push(path) })
    window.__notefastNavigate?.('/inbox')
    expect(a).toEqual([])
    expect(b).toEqual(['/inbox'])
    unA()
    expect(typeof window.__notefastNavigate).toBe('function')
    unB()
    expect(window.__notefastNavigate).toBeUndefined()
  })
})
