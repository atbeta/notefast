/**
 * 原生内嵌 bootstrap 测试
 *
 * 目标：
 * - parseNativeArgs：默认值 / CLI 参数 / 非法输入 / --help
 * - injectEngineAssets：从引擎产物根目录注入 VERSION / SQLITE_VEC_PATH /
 *   SQLITE_LIBRARY_PATH / WEB_DIST，且保留显式 env 的优先权
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { parseNativeArgs, injectEngineAssets, handleInternalRoute, DEFAULT_PORT } from '../native/bootstrap'

const ENV_KEYS = ['DATA_DIR', 'APP_VERSION', 'SQLITE_VEC_PATH', 'SQLITE_LIBRARY_PATH', 'WEB_DIST']

function saveEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {}
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  return saved
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
}

describe('parseNativeArgs', () => {
  // 注意：不能写 `process.env.DATA_DIR = undefined`——Bun ≥1.2 会写入字符串 "undefined"，
  // 还原未设置的变量必须显式 delete
  beforeEach(() => { delete process.env.DATA_DIR })

  test('缺省值：固定端口（origin 稳定保 localStorage）+ 可执行文件目录', () => {
    const args = parseNativeArgs([])
    expect(args.port).toBe(DEFAULT_PORT)
    expect(args.dataDir).toBe('./data')
    expect(args.assetsDir).toBe(dirname(process.execPath))
  })

  test('解析 CLI 参数', () => {
    const args = parseNativeArgs(['--data-dir', '/tmp/nf-test', '--port', '3140', '--assets-dir', '/tmp/assets'])
    expect(args.dataDir).toBe('/tmp/nf-test')
    expect(args.port).toBe(3140)
    expect(args.assetsDir).toBe('/tmp/assets')
  })

  test('port 0 = 随机端口', () => {
    expect(parseNativeArgs(['--port', '0']).port).toBe(0)
  })

  test('非法端口抛错', () => {
    expect(() => parseNativeArgs(['--port', '99999'])).toThrow()
    expect(() => parseNativeArgs(['--port', 'abc'])).toThrow()
  })

  test('未知参数抛错', () => {
    expect(() => parseNativeArgs(['--bogus'])).toThrow(/未知参数/)
  })
})

describe('injectEngineAssets', () => {
  let assetsDir: string
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = saveEnv()
    assetsDir = mkdtempSync(join(tmpdir(), 'nf-native-'))
  })
  afterEach(() => {
    restoreEnv(saved)
    rmSync(assetsDir, { recursive: true, force: true })
  })

  test('注入 VERSION / vec0 / libsqlite3 / web-dist', () => {
    // vec0 扩展名随平台（与 bootstrap 的 vecSuffix 一致）：CI 跑在 Linux，不能写死 .dylib
    const vecExt = process.platform === 'darwin' ? 'dylib' : process.platform === 'win32' ? 'dll' : 'so'
    writeFileSync(join(assetsDir, 'VERSION'), '0.31.0\n')
    mkdirSync(join(assetsDir, 'native'))
    writeFileSync(join(assetsDir, 'native', `vec0.${vecExt}`), 'x')
    writeFileSync(join(assetsDir, 'libsqlite3.dylib'), 'x')
    mkdirSync(join(assetsDir, 'web-dist'))
    writeFileSync(join(assetsDir, 'web-dist', 'index.html'), '<html/>')

    injectEngineAssets({ dataDir: '/tmp/dd', port: 0, assetsDir })

    expect(process.env.DATA_DIR).toBe('/tmp/dd')
    expect(process.env.APP_VERSION).toBe('0.31.0')
    expect(process.env.SQLITE_VEC_PATH).toBe(join(assetsDir, 'native', `vec0.${vecExt}`))
    expect(process.env.SQLITE_LIBRARY_PATH).toBe(join(assetsDir, 'libsqlite3.dylib'))
    expect(process.env.WEB_DIST).toBe(join(assetsDir, 'web-dist'))
  })

  test('资源缺失时不覆盖显式 env（保留既有解析逻辑）', () => {
    process.env.APP_VERSION = '1.2.3'
    process.env.SQLITE_VEC_PATH = '/custom/vec0.dylib'

    injectEngineAssets({ dataDir: '/tmp/dd', port: 0, assetsDir })

    expect(process.env.APP_VERSION).toBe('1.2.3')
    expect(process.env.SQLITE_VEC_PATH).toBe('/custom/vec0.dylib')
    expect(process.env.SQLITE_LIBRARY_PATH).toBeUndefined()
    expect(process.env.WEB_DIST).toBeUndefined()
  })

  test('DATA_DIR 始终由 --data-dir 指定', () => {
    process.env.DATA_DIR = '/env/dd'
    injectEngineAssets({ dataDir: '/arg/dd', port: 0, assetsDir })
    expect(process.env.DATA_DIR).toBe('/arg/dd')
  })
})

describe('handleInternalRoute', () => {
  test('POST /internal/shutdown 受理', () => {
    const res = handleInternalRoute(new Request('http://127.0.0.1:3140/internal/shutdown', { method: 'POST' }))
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
  })

  test('其他方法 / 路径不拦截（null 交由 app.fetch）', () => {
    expect(handleInternalRoute(new Request('http://127.0.0.1:3140/internal/shutdown'))).toBeNull()
    expect(handleInternalRoute(new Request('http://127.0.0.1:3140/api/v1/docs', { method: 'POST' }))).toBeNull()
    expect(handleInternalRoute(new Request('http://127.0.0.1:3140/anything', { method: 'POST' }))).toBeNull()
  })
})
