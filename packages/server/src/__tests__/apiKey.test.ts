import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb } from '../db'

/**
 * initApiKey 行为（经 initDb 触发，每文件独立进程）：
 * - 未配置任何鉴权：保持免鉴权（本地开发默认），不生成也不加载 api.key
 * - 配置了鉴权（如 AUTH_PASSWORD）：首次启动生成 api.key 并写入 env（供 MCP/API Bearer）
 * - 重启（鉴权已配置、key 已存在、env 未设）：加载既有 key 进 env，跨重启保持稳定
 */

let testDir: string
let originalToken: string | undefined
let originalPassword: string | undefined

beforeEach(() => {
  originalToken = process.env.API_TOKEN
  originalPassword = process.env.AUTH_PASSWORD
  process.env.API_TOKEN = ''
  process.env.AUTH_PASSWORD = ''
  testDir = mkdtempSync(join('/tmp', 'notefast-apikey-test-'))
})

afterEach(() => {
  closeDb()
  process.env.API_TOKEN = originalToken
  process.env.AUTH_PASSWORD = originalPassword
  rmSync(testDir, { recursive: true, force: true })
})

describe('initApiKey', () => {
  test('未配置任何鉴权：保持免鉴权，不生成 api.key', () => {
    initDb(testDir)

    expect(String(process.env.API_TOKEN)).toBe('')
    expect(existsSync(join(testDir, 'api.key'))).toBe(false)
  })

  test('未配置任何鉴权：既有 api.key 也不加载进 env', () => {
    writeFileSync(join(testDir, 'api.key'), 'nf_existing\n')
    initDb(testDir)

    expect(String(process.env.API_TOKEN)).toBe('')
  })

  test('配置了 AUTH_PASSWORD：首次启动生成 api.key 并写入 env', () => {
    process.env.AUTH_PASSWORD = 'pw'
    initDb(testDir)

    const key = readFileSync(join(testDir, 'api.key'), 'utf-8').trim()
    expect(key).toMatch(/^nf_[a-z0-9]{32}$/)
    expect(process.env.API_TOKEN).toBe(key)
  })

  test('鉴权已配置，重启时 api.key 已存在：加载既有 key 进 env（不重新生成）', () => {
    process.env.AUTH_PASSWORD = 'pw'
    initDb(testDir)
    const firstKey = process.env.API_TOKEN!
    closeDb()

    // 模拟重启：env 丢失，api.key 与鉴权配置仍在
    delete process.env.API_TOKEN
    process.env.AUTH_PASSWORD = 'pw'
    initDb(testDir)
    // delete 后 TS 会把读取收窄为 undefined，用 String() 绕开收窄（若为 undefined 会变 "undefined" 使断言失败）
    expect(String(process.env.API_TOKEN)).toBe(firstKey)
  })

  test('env 已显式设置时不覆盖、不写文件', () => {
    process.env.API_TOKEN = 'explicit-token'
    initDb(testDir)

    expect(process.env.API_TOKEN).toBe('explicit-token')
    expect(existsSync(join(testDir, 'api.key'))).toBe(false)
  })
})
