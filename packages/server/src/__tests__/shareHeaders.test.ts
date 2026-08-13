import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, type NoteFastServer } from '../app'

/**
 * 回归：/s/* 与 /share/* 的防嵌入安全头（X-Frame-Options / CSP frame-ancestors）
 * 曾注册在 app.route('/share', sharePublic) 之后——Hono 按注册顺序执行，
 * 导致 /share/:token 响应丢失安全头。本测试钉住「中间件先于路由」的顺序。
 */

let testDir: string
let srv: NoteFastServer
const AUTH_ENV_KEYS = ['API_TOKEN', 'AUTH_PASSWORD', 'READ_TOKEN', 'WRITE_TOKEN'] as const
let savedAuthEnv: Record<string, string | undefined>

beforeAll(async () => {
  // bun test 全部文件共享一个进程：其它文件的鉴权 env 可能泄漏过来，
  // 本文件走免鉴权直通，先清空并在结束后还原
  savedAuthEnv = {}
  for (const k of AUTH_ENV_KEYS) {
    savedAuthEnv[k] = process.env[k]
    process.env[k] = ''
  }
  testDir = mkdtempSync(join('/tmp', 'notefast-share-headers-'))
  srv = createApp({ dataDir: testDir })
  await srv.start()
})

afterAll(async () => {
  await srv.stop()
  for (const k of AUTH_ENV_KEYS) {
    // Bun ≥1.2 下 process.env.X = undefined 会写入字符串 "undefined"，须显式 delete
    if (savedAuthEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedAuthEnv[k]
  }
  rmSync(testDir, { recursive: true, force: true })
})

describe('分享公开端点安全头（denyFraming）', () => {
  test('GET /share/:token 带 X-Frame-Options: DENY 与 CSP frame-ancestors', async () => {
    const created = await srv.app.fetch(new Request('http://localhost/api/v1/docs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notebook_id: srv.notebookId, title: '安全头回归', markdown: '正文' }),
    }))
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }

    const shareRes = await srv.app.fetch(
      new Request(`http://localhost/api/v1/docs/${id}/share`, { method: 'PUT' }),
    )
    expect(shareRes.status).toBe(200)
    const { token } = (await shareRes.json()) as { token: string }

    const pub = await srv.app.fetch(new Request(`http://localhost/share/${token}`))
    expect(pub.status).toBe(200)
    expect(pub.headers.get('x-frame-options')).toBe('DENY')
    expect(pub.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")

    // 无效 token 的 404 同样带头（中间件挂在路径前缀上，与路由是否命中无关）
    const missing = await srv.app.fetch(
      new Request('http://localhost/share/0123456789abcdef0123456789abcdef'),
    )
    expect(missing.status).toBe(404)
    expect(missing.headers.get('x-frame-options')).toBe('DENY')
    expect(missing.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
  })
})
