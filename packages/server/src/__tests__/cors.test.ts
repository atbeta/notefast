import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createApp } from '../app'

/**
 * CORS 中间件（app.ts 顶部）：
 * - CORS_ORIGINS 逗号分隔精确匹配；任一项为字面 * 时通配任意 origin
 * - 默认（未配置 env）仅允许 http://localhost:5173
 * - allowMethods 含 PUT（PUT /docs/:id/markdown 等端点的跨域 preflight 需要）
 *
 * createApp 只做构造、无数据层副作用，CORS 在构造函数内注册，
 * preflight（OPTIONS）由 cors 中间件直接 204 短路，因此无需 start()。
 */

const ENV_KEYS = ['CORS_ORIGINS', 'API_TOKEN', 'AUTH_PASSWORD', 'READ_TOKEN', 'WRITE_TOKEN'] as const
let savedEnv: Record<string, string | undefined>

beforeAll(() => {
  // bun test 全部文件共享一个进程：其它文件的鉴权 env 可能泄漏过来，
  // 本文件只断言 CORS 行为，先清空并在结束后还原
  savedEnv = {}
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterAll(() => {
  // 还原未设置的变量必须显式 delete（Bun ≥1.2 下赋 undefined 会写入字符串 "undefined"）
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

function preflight(app: ReturnType<typeof createApp>['app'], origin: string, requestMethod = 'POST') {
  return app.fetch(new Request('http://localhost/api/v1/version', {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': requestMethod,
      'Access-Control-Request-Headers': 'Authorization, Content-Type',
    },
  }))
}

describe('CORS 中间件', () => {
  test('CORS_ORIGINS=* 时任意 origin 的 preflight 被允许，Allow-Headers 含 Authorization', async () => {
    process.env.CORS_ORIGINS = '*'
    const srv = createApp({ dataDir: '/tmp/notefast-cors-star' })

    const res = await preflight(srv.app, 'https://anywhere.example')
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Access-Control-Allow-Headers') || '').toContain('Authorization')
    expect(res.headers.get('Access-Control-Allow-Methods') || '').toContain('PUT')

    // 简单请求同样带通配 Allow-Origin
    const get = await srv.app.fetch(new Request('http://localhost/api/v1/version', {
      headers: { Origin: 'https://anywhere.example' },
    }))
    expect(get.status).toBe(200)
    expect(get.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  test('配置项中混入 *（如 "https://a.com, *"）同样按通配处理', async () => {
    process.env.CORS_ORIGINS = 'https://a.com, *'
    const srv = createApp({ dataDir: '/tmp/notefast-cors-mixed' })

    const res = await preflight(srv.app, 'https://elsewhere.example')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  test('默认（未配置 CORS_ORIGINS）仍只允许 localhost:5173', async () => {
    delete process.env.CORS_ORIGINS
    const srv = createApp({ dataDir: '/tmp/notefast-cors-default' })

    const allowed = await preflight(srv.app, 'http://localhost:5173', 'PUT')
    expect(allowed.status).toBe(204)
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
    // PUT 已补入 allowMethods（既有 PUT 端点的跨域 preflight 缺口）
    expect(allowed.headers.get('Access-Control-Allow-Methods') || '').toContain('PUT')

    // 未列出的 origin 不带 Allow-Origin（精确匹配，['*'] 之外的数组不通配）
    const denied = await preflight(srv.app, 'https://evil.example')
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull()

    const get = await srv.app.fetch(new Request('http://localhost/api/v1/version', {
      headers: { Origin: 'https://evil.example' },
    }))
    expect(get.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  test('字面 ["*"] 之外的显式列表保持精确匹配（回归）', async () => {
    process.env.CORS_ORIGINS = 'https://a.com, https://b.com'
    const srv = createApp({ dataDir: '/tmp/notefast-cors-list' })

    const ok = await preflight(srv.app, 'https://b.com')
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://b.com')

    const no = await preflight(srv.app, 'https://c.com')
    expect(no.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})
