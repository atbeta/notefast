/**
 * 网页侧「切模式」桥（RFC 0005）：浏览器形态必须返回 false，
 * Tauri / macOS 壳各自走自己的通道（invoke / WK postMessage）。
 *
 * 这里直接 stub `window` / `document`：bun test 无 DOM，逻辑本身只依赖这两个全局。
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { canSwitchModeFromShell, nativeLeaveVault, nativePickVaultFolder } from '../nativeVault'

const g = globalThis as unknown as { window?: unknown; document?: unknown }

function setEnv(opts: {
  shell?: string | null
  invoke?: ((cmd: string) => Promise<unknown>) | null
  postMessage?: ((msg: unknown) => void) | null
}): { calls: string[]; replaced: string[] } {
  const calls: string[] = []
  const replaced: string[] = []
  const bridge = opts.postMessage ? { messageHandlers: { notefast: { postMessage: opts.postMessage } } } : undefined
  g.document = { documentElement: { getAttribute: () => opts.shell ?? null } }
  g.window = {
    ...(opts.invoke ? { __TAURI__: { core: { invoke: (cmd: string) => {
      calls.push(cmd)
      return opts.invoke!(cmd)
    } } } } : {}),
    ...(bridge ? { webkit: bridge } : {}),
    location: { replace: (u: string) => replaced.push(u) },
  }
  return { calls, replaced }
}

afterEach(() => {
  delete g.window
  delete g.document
})

describe('canSwitchModeFromShell', () => {
  test('无 DOM（浏览器 / SSR）：false', () => {
    expect(canSwitchModeFromShell()).toBe(false)
  })

  test('浏览器形态（无 data-shell / 无桥）：false', () => {
    setEnv({ shell: null })
    expect(canSwitchModeFromShell()).toBe(false)
  })

  test('Tauri 壳：true；macOS WK 桥：true', () => {
    setEnv({ shell: 'tauri', invoke: async () => null })
    expect(canSwitchModeFromShell()).toBe(true)
    setEnv({ shell: 'macos', postMessage: () => {} })
    expect(canSwitchModeFromShell()).toBe(true)
  })
})

describe('nativePickVaultFolder', () => {
  test('Tauri：调 vault_pick_and_open 并跳到新入口', async () => {
    const { calls, replaced } = setEnv({
      shell: 'tauri',
      invoke: async () => ({ url: 'http://127.0.0.1:3999/?native=tauri' }),
    })
    expect(await nativePickVaultFolder()).toBe(true)
    expect(calls).toEqual(['vault_pick_and_open'])
    expect(replaced).toEqual(['http://127.0.0.1:3999/?native=tauri'])
  })

  test('Tauri：用户取消（无 url）→ false 且不跳转', async () => {
    const { replaced } = setEnv({ shell: 'tauri', invoke: async () => null })
    expect(await nativePickVaultFolder()).toBe(false)
    expect(replaced).toEqual([])
  })

  test('macOS 壳：postMessage openVault，由壳自己导航', async () => {
    const messages: unknown[] = []
    setEnv({ shell: 'macos', postMessage: (m) => messages.push(m) })
    expect(await nativePickVaultFolder()).toBe(true)
    expect(messages).toEqual([{ type: 'openVault' }])
  })

  test('浏览器：false（调用方不该渲染入口）', async () => {
    setEnv({ shell: null })
    expect(await nativePickVaultFolder()).toBe(false)
  })
})

describe('nativeLeaveVault', () => {
  test('Tauri：调 use_db_mode 并跳到新入口', async () => {
    const { calls, replaced } = setEnv({
      shell: 'tauri',
      invoke: async () => ({ url: 'http://127.0.0.1:3999/?native=tauri' }),
    })
    expect(await nativeLeaveVault()).toBe(true)
    expect(calls).toEqual(['use_db_mode'])
    expect(replaced).toHaveLength(1)
  })

  test('macOS 壳：postMessage leaveVault', async () => {
    const messages: unknown[] = []
    setEnv({ shell: 'macos', postMessage: (m) => messages.push(m) })
    expect(await nativeLeaveVault()).toBe(true)
    expect(messages).toEqual([{ type: 'leaveVault' }])
  })

  test('浏览器：false', async () => {
    setEnv({ shell: null })
    expect(await nativeLeaveVault()).toBe(false)
  })
})
