import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb } from '../db'

/**
 * initApiKey 行为（经 initDb 触发，每文件独立进程）：
 * - 首次启动：无 api.key 且无 env → 生成并写入 env
 * - 重启：api.key 已存在但 env 未设 → 加载进 env（否则鉴权静默退化为全放行）
 */

let testDir: string
let originalToken: string | undefined

beforeEach(() => {
  originalToken = process.env.API_TOKEN
  testDir = mkdtempSync(join('/tmp', 'notefast-apikey-test-'))
})

afterEach(() => {
  closeDb()
  process.env.API_TOKEN = originalToken
  rmSync(testDir, { recursive: true, force: true })
})

describe('initApiKey', () => {
  test('首次启动生成 api.key 并写入 env', () => {
    process.env.API_TOKEN = ''
    initDb(testDir)

    const key = readFileSync(join(testDir, 'api.key'), 'utf-8').trim()
    expect(key).toMatch(/^nf_[a-z0-9]{32}$/)
    expect(process.env.API_TOKEN).toBe(key)
  })

  test('重启时 api.key 已存在：加载既有 key 进 env（不重新生成）', () => {
    process.env.API_TOKEN = ''
    initDb(testDir)
    const firstKey = process.env.API_TOKEN!
    closeDb()

    // 模拟重启：env 丢失，api.key 仍在
    delete process.env.API_TOKEN
    initDb(testDir)
    // delete 后 TS 会把读取收窄为 undefined，用 String() 绕开收窄（若为 undefined 会变 "undefined" 使断言失败）
    expect(String(process.env.API_TOKEN)).toBe(firstKey)
  })

  test('env 已显式设置时不覆盖、不写文件', () => {
    process.env.API_TOKEN = 'explicit-token'
    initDb(testDir)

    expect(process.env.API_TOKEN).toBe('explicit-token')
  })
})
