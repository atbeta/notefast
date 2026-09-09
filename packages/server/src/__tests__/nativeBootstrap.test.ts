/**
 * 原生内嵌 bootstrap 测试
 *
 * 目标：
 * - parseNativeArgs：默认值 / CLI 参数 / 非法输入 / --help / vault 参数
 * - injectEngineAssets：从引擎产物根目录注入 VERSION / SQLITE_VEC_PATH /
 *   SQLITE_LIBRARY_PATH / WEB_DIST，且保留显式 env 的优先权
 * - vaultDataDir / vaultPathHash：一个 vault 一个 DATA_DIR（RFC 0001 D4）
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname } from 'node:path'
import {
  parseNativeArgs,
  injectEngineAssets,
  handleInternalRoute,
  DEFAULT_PORT,
  VAULT_DIR_HASH_LEN,
  canonicalVaultPath,
  vaultPathHash,
  vaultDataDir,
} from '../native/bootstrap'

const ENV_KEYS = [
  'DATA_DIR',
  'APP_VERSION',
  'SQLITE_VEC_PATH',
  'SQLITE_LIBRARY_PATH',
  'WEB_DIST',
  'VAULT_PATH',
  'NOTEFAST_APP_SUPPORT_DIR',
]

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

/** 与 bootstrap 同口径的独立期望值：sha256(realpath) 前 12 位 */
function expectedHash(path: string): string {
  return createHash('sha256').update(realpathSync(path)).digest('hex').slice(0, VAULT_DIR_HASH_LEN)
}

function minimalArgs(dataDir: string, assetsDir: string): Parameters<typeof injectEngineAssets>[0] {
  return { dataDir, port: 0, assetsDir, vaultPath: null, appSupportDir: '/tmp/nf-support' }
}

describe('parseNativeArgs', () => {
  // 注意：不能写 `process.env.DATA_DIR = undefined`——Bun ≥1.2 会写入字符串 "undefined"，
  // 还原未设置的变量必须显式 delete
  let saved: Record<string, string | undefined>
  beforeEach(() => {
    saved = saveEnv()
    delete process.env.DATA_DIR
    delete process.env.VAULT_PATH
    delete process.env.NOTEFAST_APP_SUPPORT_DIR
  })
  afterEach(() => restoreEnv(saved))

  test('缺省值：固定端口（origin 稳定保 localStorage）+ 可执行文件目录', () => {
    const args = parseNativeArgs([])
    expect(args.port).toBe(DEFAULT_PORT)
    expect(args.dataDir).toBe('./data')
    expect(args.assetsDir).toBe(dirname(process.execPath))
    expect(args.vaultPath).toBeNull()
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

  test('--vault-path：DATA_DIR 派生为 <app-support-dir>/<sha256 前 12 位>', () => {
    const vault = mkdtempSync(join(tmpdir(), 'nf-vault-'))
    const support = mkdtempSync(join(tmpdir(), 'nf-support-'))
    try {
      const args = parseNativeArgs(['--vault-path', vault, '--app-support-dir', support])
      expect(args.vaultPath).toBe(vault)
      expect(args.appSupportDir).toBe(support)
      expect(args.dataDir).toBe(join(support, expectedHash(vault)))
      expect(args.dataDir).not.toBe(vault)
    } finally {
      rmSync(vault, { recursive: true, force: true })
      rmSync(support, { recursive: true, force: true })
    }
  })

  test('VAULT_PATH env 同样触发派生（壳可只设环境变量）', () => {
    const vault = mkdtempSync(join(tmpdir(), 'nf-vault-env-'))
    const support = mkdtempSync(join(tmpdir(), 'nf-support-env-'))
    try {
      process.env.VAULT_PATH = vault
      process.env.NOTEFAST_APP_SUPPORT_DIR = support
      const args = parseNativeArgs([])
      expect(args.vaultPath).toBe(vault)
      expect(args.dataDir).toBe(join(support, expectedHash(vault)))
    } finally {
      rmSync(vault, { recursive: true, force: true })
      rmSync(support, { recursive: true, force: true })
    }
  })

  test('显式 --data-dir 优先于 vault 派生（排障出口）', () => {
    const vault = mkdtempSync(join(tmpdir(), 'nf-vault-explicit-'))
    try {
      const args = parseNativeArgs([
        '--vault-path', vault,
        '--app-support-dir', '/tmp/nf-support',
        '--data-dir', '/tmp/nf-explicit',
      ])
      expect(args.vaultPath).toBe(vault)
      expect(args.dataDir).toBe('/tmp/nf-explicit')
    } finally {
      rmSync(vault, { recursive: true, force: true })
    }
  })

  test('DATA_DIR env 也算显式指定，不覆盖', () => {
    const vault = mkdtempSync(join(tmpdir(), 'nf-vault-envdd-'))
    try {
      process.env.DATA_DIR = '/env/dd'
      const args = parseNativeArgs(['--vault-path', vault])
      expect(args.dataDir).toBe('/env/dd')
    } finally {
      rmSync(vault, { recursive: true, force: true })
    }
  })
})

describe('vaultDataDir（一个 vault 一个索引，RFC 0001 D4）', () => {
  test('目录名是 sha256(canonical path) 前 12 位十六进制', () => {
    const vault = mkdtempSync(join(tmpdir(), 'nf-vault-hash-'))
    try {
      const dir = vaultDataDir(vault, '/tmp/nf-support')
      const name = dir.slice('/tmp/nf-support/'.length)
      expect(name).toHaveLength(VAULT_DIR_HASH_LEN)
      expect(name).toMatch(/^[0-9a-f]{12}$/)
      expect(name).toBe(expectedHash(vault))
    } finally {
      rmSync(vault, { recursive: true, force: true })
    }
  })

  test('同一路径的不同写法落到同一目录（尾部分隔符 / 相对写法）', () => {
    const vault = mkdtempSync(join(tmpdir(), 'nf-vault-canon-'))
    try {
      const withSlash = vaultDataDir(vault + '/', '/tmp/nf-support')
      const plain = vaultDataDir(vault, '/tmp/nf-support')
      const relative = vaultDataDir(join(vault, '.', 'sub', '..'), '/tmp/nf-support')
      expect(withSlash).toBe(plain)
      expect(relative).toBe(plain)
    } finally {
      rmSync(vault, { recursive: true, force: true })
    }
  })

  test('符号链接指向同一文件夹 → 同一索引目录（macOS /tmp 与 /private/tmp）', () => {
    if (process.platform === 'win32') return // 建符号链接需要管理员权限
    const vault = mkdtempSync(join(tmpdir(), 'nf-vault-link-'))
    const link = join(mkdtempSync(join(tmpdir(), 'nf-vault-link-parent-')), 'alias')
    try {
      symlinkSync(vault, link, 'dir')
      expect(canonicalVaultPath(link)).toBe(realpathSync(vault))
      expect(vaultDataDir(link, '/tmp/nf-support')).toBe(vaultDataDir(vault, '/tmp/nf-support'))
    } finally {
      rmSync(vault, { recursive: true, force: true })
      rmSync(dirname(link), { recursive: true, force: true })
    }
  })

  test('不同 vault → 不同索引目录', () => {
    const a = mkdtempSync(join(tmpdir(), 'nf-vault-a-'))
    const b = mkdtempSync(join(tmpdir(), 'nf-vault-b-'))
    try {
      expect(vaultDataDir(a, '/tmp/nf-support')).not.toBe(vaultDataDir(b, '/tmp/nf-support'))
      expect(vaultPathHash(a)).not.toBe(vaultPathHash(b))
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
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

    injectEngineAssets(minimalArgs('/tmp/dd', assetsDir))

    expect(process.env.DATA_DIR).toBe('/tmp/dd')
    expect(process.env.APP_VERSION).toBe('0.31.0')
    expect(process.env.SQLITE_VEC_PATH).toBe(join(assetsDir, 'native', `vec0.${vecExt}`))
    expect(process.env.SQLITE_LIBRARY_PATH).toBe(join(assetsDir, 'libsqlite3.dylib'))
    expect(process.env.WEB_DIST).toBe(join(assetsDir, 'web-dist'))
  })

  test('资源缺失时不覆盖显式 env（保留既有解析逻辑）', () => {
    process.env.APP_VERSION = '1.2.3'
    process.env.SQLITE_VEC_PATH = '/custom/vec0.dylib'

    injectEngineAssets(minimalArgs('/tmp/dd', assetsDir))

    expect(process.env.APP_VERSION).toBe('1.2.3')
    expect(process.env.SQLITE_VEC_PATH).toBe('/custom/vec0.dylib')
    expect(process.env.SQLITE_LIBRARY_PATH).toBeUndefined()
    expect(process.env.WEB_DIST).toBeUndefined()
  })

  test('DATA_DIR 始终由 --data-dir 指定', () => {
    process.env.DATA_DIR = '/env/dd'
    injectEngineAssets(minimalArgs('/arg/dd', assetsDir))
    expect(process.env.DATA_DIR).toBe('/arg/dd')
  })

  test('vault 模式透传 VAULT_PATH + 派生 DATA_DIR 到 env', () => {
    const vault = mkdtempSync(join(tmpdir(), 'nf-vault-inject-'))
    const support = mkdtempSync(join(tmpdir(), 'nf-support-inject-'))
    try {
      const args = parseNativeArgs(['--vault-path', vault, '--app-support-dir', support])
      injectEngineAssets(args)

      expect(process.env.VAULT_PATH).toBe(vault)
      expect(process.env.DATA_DIR).toBe(join(support, expectedHash(vault)))
      expect(process.env.DATA_DIR).not.toBe(vault)
    } finally {
      rmSync(vault, { recursive: true, force: true })
      rmSync(support, { recursive: true, force: true })
    }
  })

  test('普通模式不写 VAULT_PATH（引擎按 db notebook 启动）', () => {
    delete process.env.VAULT_PATH
    injectEngineAssets(minimalArgs('/tmp/dd', assetsDir))
    expect(process.env.VAULT_PATH).toBeUndefined()
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
