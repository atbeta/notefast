import { beforeEach, describe, expect, test } from 'bun:test'
import {
  NATIVE_SHELL_STORAGE_KEY,
  applyNativeShellMarker,
  isKnownNativeShell,
  isNativeReloadShortcut,
  parseNativeQuery,
  persistNativeShell,
  readStoredNativeShell,
  resolveNativeShell,
} from '../nativeShell'

function installMemorySessionStorage() {
  const store = new Map<string, string>()
  const ss = {
    getItem(k: string) {
      return store.has(k) ? store.get(k)! : null
    },
    setItem(k: string, v: string) {
      store.set(k, String(v))
    },
    removeItem(k: string) {
      store.delete(k)
    },
    clear() {
      store.clear()
    },
    key(i: number) {
      return [...store.keys()][i] ?? null
    },
    get length() {
      return store.size
    },
  }
  Object.defineProperty(globalThis, 'sessionStorage', { value: ss, configurable: true })
}

installMemorySessionStorage()

beforeEach(() => {
  sessionStorage.clear()
})

describe('parseNativeQuery', () => {
  test('native=1 视为 tauri', () => {
    expect(parseNativeQuery('?native=1')).toBe('tauri')
    expect(parseNativeQuery('?foo=1&native=1')).toBe('tauri')
  })

  test('具名壳', () => {
    expect(parseNativeQuery('?native=tauri')).toBe('tauri')
    expect(parseNativeQuery('?native=macos')).toBe('macos')
    expect(parseNativeQuery('/doc/x?edit=1&native=windows')).toBe('windows')
  })

  test('无参数或非法值', () => {
    expect(parseNativeQuery('')).toBeNull()
    expect(parseNativeQuery('?q=1')).toBeNull()
    expect(parseNativeQuery('?native=browser')).toBeNull()
  })
})

describe('resolveNativeShell', () => {
  test('query 优先于存储与 Tauri 探测', () => {
    expect(resolveNativeShell({
      search: '?native=macos',
      stored: 'tauri',
      hasTauri: true,
    })).toBe('macos')
  })

  test('无 query 时用 sessionStorage（刷新后 URL 已无 native）', () => {
    expect(resolveNativeShell({
      search: '/doc/abc',
      stored: 'tauri',
    })).toBe('tauri')
  })

  test('存储非法值忽略，可回退 __TAURI__', () => {
    expect(resolveNativeShell({ stored: 'chrome', hasTauri: true })).toBe('tauri')
    expect(resolveNativeShell({ stored: 'chrome' })).toBeNull()
  })

  test('浏览器形态全空', () => {
    expect(resolveNativeShell({ search: '?q=1' })).toBeNull()
  })
})

describe('persistNativeShell', () => {
  test('合法壳写入，非法值忽略', () => {
    persistNativeShell('tauri')
    expect(readStoredNativeShell()).toBe('tauri')
    expect(sessionStorage.getItem(NATIVE_SHELL_STORAGE_KEY)).toBe('tauri')
    persistNativeShell('not-a-shell')
    expect(readStoredNativeShell()).toBe('tauri')
  })
})

describe('applyNativeShellMarker', () => {
  test('打 native-shell class 与 data-shell', () => {
    const classList = new Set<string>()
    const attrs: Record<string, string> = {}
    const root = {
      classList: { add: (c: string) => { classList.add(c) } },
      setAttribute: (n: string, v: string) => { attrs[n] = v },
    }
    applyNativeShellMarker('tauri', root as unknown as HTMLElement)
    expect(classList.has('native-shell')).toBe(true)
    expect(attrs['data-shell']).toBe('tauri')
  })

  test('未知壳名不写', () => {
    const attrs: Record<string, string> = {}
    applyNativeShellMarker('chrome', {
      classList: { add: () => { throw new Error('should not add') } },
      setAttribute: (n: string, v: string) => { attrs[n] = v },
    } as unknown as HTMLElement)
    expect(attrs['data-shell']).toBeUndefined()
  })
})

describe('isKnownNativeShell', () => {
  test('只认四族壳名', () => {
    expect(isKnownNativeShell('tauri')).toBe(true)
    expect(isKnownNativeShell('macos')).toBe(true)
    expect(isKnownNativeShell('')).toBe(false)
    expect(isKnownNativeShell(null)).toBe(false)
  })
})

describe('isNativeReloadShortcut', () => {
  test('F5 / Ctrl+R / Cmd+R / Ctrl+Shift+R', () => {
    expect(isNativeReloadShortcut({ key: 'F5' })).toBe(true)
    expect(isNativeReloadShortcut({ key: 'r', ctrlKey: true })).toBe(true)
    expect(isNativeReloadShortcut({ key: 'R', ctrlKey: true })).toBe(true)
    expect(isNativeReloadShortcut({ key: 'r', metaKey: true })).toBe(true)
    expect(isNativeReloadShortcut({ key: 'r', ctrlKey: true, metaKey: false })).toBe(true)
  })

  test('不误伤其它键', () => {
    expect(isNativeReloadShortcut({ key: 'r' })).toBe(false)
    expect(isNativeReloadShortcut({ key: 'k', ctrlKey: true })).toBe(false)
    expect(isNativeReloadShortcut({ key: 'F5', ctrlKey: true })).toBe(true)
  })
})
