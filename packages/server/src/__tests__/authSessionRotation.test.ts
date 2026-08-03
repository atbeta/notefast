/**
 * 密码变更 → 会话轮换测试
 *
 * 目标（bug：docker-compose 改密码后重启，已登录 session 不清理）：
 * - 首次启动：记录密码指纹，不撤销（无会话可撤）
 * - 密码不变重启：会话保持有效
 * - 密码变更重启：全部 web-session token 被撤销（下次请求 401）
 * - 密码删除（回免鉴权）：同样触发撤销
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb, getDb } from '../db'
import { createWebSessionToken, verifyToken } from '../services/apiTokens'

let testDir: string
let originalPassword: string | undefined
let originalToken: string | undefined

beforeEach(() => {
  originalPassword = process.env.AUTH_PASSWORD
  originalToken = process.env.API_TOKEN
  process.env.AUTH_PASSWORD = ''
  process.env.API_TOKEN = ''
  testDir = mkdtempSync(join('/tmp', 'notefast-auth-session-test-'))
})

afterEach(() => {
  closeDb()
  process.env.AUTH_PASSWORD = originalPassword
  // initDb 在配置了密码时会生成 api.key 并写入 API_TOKEN——必须一并还原，
  // 否则泄漏给同进程后执行的其它测试文件（bun test 全部文件共享一个进程）
  process.env.API_TOKEN = originalToken
  rmSync(testDir, { recursive: true, force: true })
})

describe('revokeWebSessionsIfPasswordChanged', () => {
  test('首次启动：记录密码指纹，不撤销既有会话', () => {
    process.env.AUTH_PASSWORD = 'pw'
    initDb(testDir)
    const { plain } = createWebSessionToken(true)
    expect(verifyToken(plain)).not.toBeNull()

    const state = JSON.parse(readFileSync(join(testDir, 'auth.state.json'), 'utf-8'))
    expect(typeof state.passwordFingerprint).toBe('string')
    expect(state.passwordFingerprint).toHaveLength(64)
  })

  test('密码不变重启：会话保持有效', () => {
    process.env.AUTH_PASSWORD = 'pw'
    initDb(testDir)
    const { plain } = createWebSessionToken(true)
    closeDb()

    initDb(testDir)
    expect(verifyToken(plain)).not.toBeNull()
  })

  test('密码变更重启：全部 web-session token 被撤销', () => {
    process.env.AUTH_PASSWORD = 'old-pw'
    initDb(testDir)
    const { plain } = createWebSessionToken(true)
    closeDb()

    process.env.AUTH_PASSWORD = 'new-pw'
    initDb(testDir)
    expect(verifyToken(plain)).toBeNull()
  })

  test('密码删除（回免鉴权）：同样撤销会话', () => {
    process.env.AUTH_PASSWORD = 'pw'
    initDb(testDir)
    const { plain } = createWebSessionToken(true)
    closeDb()

    process.env.AUTH_PASSWORD = ''
    initDb(testDir)
    expect(verifyToken(plain)).toBeNull()
  })

  test('指纹状态写入 data 目录', () => {
    process.env.AUTH_PASSWORD = 'pw'
    initDb(testDir)
    expect(existsSync(join(testDir, 'auth.state.json'))).toBe(true)
    // 撤销依赖 getDb()：initDb 时序内 db 已打开（无副作用）
    expect(getDb()).toBeDefined()
  })
})
