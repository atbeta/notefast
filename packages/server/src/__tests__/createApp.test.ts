import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createApp } from '../app'

/**
 * Server 库化入口（createApp）：
 * - start() 幂等、初始化数据层并暴露 notebookId/version
 * - app 是纯 Hono（不 Bun.serve），可直接 app.fetch 供任意宿主（原生客户端）使用
 * - stop() 幂等清理
 */

let testDir: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-createapp-'))
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('createApp', () => {
  test('start() 初始化并暴露 notebookId/version；app 可 app.fetch 服务请求', async () => {
    const srv = createApp({ dataDir: testDir })
    const started = await srv.start()

    expect(started.notebookId).toBeTruthy()
    expect(started.version).toMatch(/^\d+\.\d+\.\d+$/)

    // app 不经 Bun.serve 直接可用（原生端内嵌的核心能力）
    const health = await srv.app.fetch(new Request('http://localhost/health'))
    expect(health.status).toBe(200)
    const healthBody = (await health.json()) as { status: string }
    expect(healthBody.status).toBe('ok')

    const version = await srv.app.fetch(new Request('http://localhost/api/v1/version'))
    expect(version.status).toBe(200)

    // start 幂等：重复调用不重新初始化（模块级单例不重建）
    const again = await srv.start()
    expect(again.notebookId).toBe(started.notebookId)

    await srv.stop()
  })

  test('stop() 幂等（重复调用不抛错）', async () => {
    const srv = createApp({ dataDir: testDir })
    await srv.start()
    await srv.stop()
    await srv.stop() // 第二次无害
  })

  test('不同 dataDir 创建各自实例（返回独立句柄）', async () => {
    const srv = createApp({ dataDir: testDir })
    const srv2 = createApp({ dataDir: join(testDir, 'nested') })
    expect(srv).not.toBe(srv2)
    expect(srv.app).not.toBe(srv2.app)
  })
})
