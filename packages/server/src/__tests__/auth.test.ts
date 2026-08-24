import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { authMiddleware, isAuthEnabled } from '../middleware/auth'
import { createToken, createWebSessionToken, revokeWebSessionTokens, listTokens } from '../services/apiTokens'
import { getDb } from '../db'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb } from '../db'

let testDir: string
const AUTH_ENV_KEYS = ['API_TOKEN', 'AUTH_PASSWORD', 'READ_TOKEN', 'WRITE_TOKEN'] as const
let savedAuthEnv: Record<string, string | undefined>

beforeAll(() => {
  // bun test 全部文件共享一个进程：先清空四个鉴权 env 再 initDb，
  // 避免泄漏的 env 触发 api.key 生成并写入 process.env.API_TOKEN
  savedAuthEnv = {}
  for (const k of AUTH_ENV_KEYS) {
    savedAuthEnv[k] = process.env[k]
    delete process.env[k]
  }
  testDir = mkdtempSync(join('/tmp', 'notefast-auth-test-'))
  initDb(testDir)
})

afterAll(() => {
  // 还原未设置的变量必须显式 delete（Bun ≥1.2 下赋 undefined 会写入字符串 "undefined"）
  for (const k of AUTH_ENV_KEYS) {
    if (savedAuthEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedAuthEnv[k]
  }
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

function createApp() {
  const app = new Hono()
  app.use('/api/*', authMiddleware)
  app.get('/api/v1/test', (c) => c.json({ ok: true }))
  app.post('/api/v1/test', (c) => c.json({ ok: true }))
  return app
}

describe('authMiddleware', () => {
  test('无鉴权配置时允许通过', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = ''
    expect(isAuthEnabled()).toBe(false)

    const app = createApp()
    const res = await app.fetch(new Request('http://localhost/api/v1/test'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })
  })

  test('Bearer Token 鉴权通过', async () => {
    process.env.API_TOKEN = 'test-token-123'
    process.env.AUTH_PASSWORD = ''

    const app = createApp()
    const res = await app.fetch(
      new Request('http://localhost/api/v1/test', {
        headers: { Authorization: 'Bearer test-token-123' },
      }),
    )
    expect(res.status).toBe(200)
  })

  test('错误的 Bearer Token 返回 401', async () => {
    process.env.API_TOKEN = 'test-token-123'
    process.env.AUTH_PASSWORD = ''

    const app = createApp()
    const res = await app.fetch(
      new Request('http://localhost/api/v1/test', {
        headers: { Authorization: 'Bearer wrong-token' },
      }),
    )
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('unauthorized')
  })

  test('Basic Auth 鉴权通过', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = 'mypassword'

    const app = createApp()
    const res = await app.fetch(
      new Request('http://localhost/api/v1/test', {
        headers: { Authorization: 'Basic ' + btoa('admin:mypassword') },
      }),
    )
    expect(res.status).toBe(200)
  })

  test('错误的密码返回 401', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = 'mypassword'

    const app = createApp()
    const res = await app.fetch(
      new Request('http://localhost/api/v1/test', {
        headers: { Authorization: 'Basic ' + btoa('admin:wrongpass') },
      }),
    )
    expect(res.status).toBe(401)
  })

  test('无 Authorization header 返回 401', async () => {
    process.env.API_TOKEN = 'required-token'

    const app = createApp()
    const res = await app.fetch(new Request('http://localhost/api/v1/test'))
    expect(res.status).toBe(401)
  })

  test('URL query ?token= 不再接受（避免日志泄露）', async () => {
    process.env.API_TOKEN = 'test-token-123'
    process.env.AUTH_PASSWORD = ''

    const app = createApp()
    const res = await app.fetch(new Request('http://localhost/api/v1/test?token=test-token-123'))
    expect(res.status).toBe(401)
  })

  test('非法 Base64 编码不导致 500', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = 'mypassword'

    const app = createApp()
    const res = await app.fetch(
      new Request('http://localhost/api/v1/test', {
        headers: { Authorization: 'Basic !!!not-valid-base64!!!' },
      }),
    )
    expect(res.status).toBe(401)
  })

  test('api_tokens 的 scopes 为非法 JSON 时返回 401 而非 500', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = 'mypassword'

    const { plain, record } = createToken('broken-scopes', ['read'])
    // 模拟历史写入 / 直接 SQL 操作产生的脏数据
    getDb().query('UPDATE api_tokens SET scopes = ? WHERE token_id = ?').run('not-json{', record.token_id)

    const app = createApp()
    const res = await app.fetch(
      new Request('http://localhost/api/v1/test', {
        headers: { Authorization: `Bearer ${plain}` },
      }),
    )
    expect(res.status).toBe(401)
  })

  test('环境变量前后空格被 trim 掉', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = '  mypassword  '

    const app = createApp()
    const res = await app.fetch(
      new Request('http://localhost/api/v1/test', {
        headers: { Authorization: 'Basic ' + btoa('admin:mypassword') },
      }),
    )
    expect(res.status).toBe(200)
  })

  test('会话 token 鉴权通过', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = 'test-pw'

    const { plain } = createWebSessionToken(true) // remember=7d
    const app = createApp()
    const res = await app.fetch(
      new Request('http://localhost/api/v1/test', {
        headers: { Authorization: `Bearer ${plain}` },
      }),
    )
    expect(res.status).toBe(200)
  })

  test('过期的会话 token 返回 401', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = 'test-pw'

    const { tokenId, plain } = createWebSessionToken(true)
    // 手动将 expires_at 设为过去时间
    getDb().query("UPDATE api_tokens SET expires_at = datetime('now', '-1 day') WHERE token_id = ?")
      .run(tokenId)

    const app = createApp()
    const res = await app.fetch(
      new Request('http://localhost/api/v1/test', {
        headers: { Authorization: `Bearer ${plain}` },
      }),
    )
    expect(res.status).toBe(401)
  })

  test('revokeWebSessionTokens 撤销后 token 立即失效', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = 'test-pw'

    const { plain } = createWebSessionToken(true)
    revokeWebSessionTokens()

    const app = createApp()
    const res = await app.fetch(
      new Request('http://localhost/api/v1/test', {
        headers: { Authorization: `Bearer ${plain}` },
      }),
    )
    expect(res.status).toBe(401)
  })

  test('listTokens 不包含 web-session token', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = 'test-pw'

    // 清理残留的 web-session token（前序测试可能留下）
    getDb().query("DELETE FROM api_tokens WHERE name = 'web-session'").run()

    createWebSessionToken(true)
    createToken('my-app', ['read'])

    const tokens = listTokens()
    // 排除 web-session 后只应看到用户创建的 token
    const names = tokens.map((t) => t.name)
    expect(names).toContain('my-app')
    expect(names).not.toContain('web-session')
  })

  test('web-session token 的 scopes 为 admin', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = 'test-pw'

    getDb().query("DELETE FROM api_tokens WHERE name = 'web-session'").run()

    const { plain } = createWebSessionToken(true)
    // 验证 admin scope：token 能通过 admin 级鉴权
    const app = createApp()
    const res = await app.fetch(
      new Request('http://localhost/api/v1/test', {
        headers: { Authorization: `Bearer ${plain}` },
      }),
    )
    expect(res.status).toBe(200)
  })
})

describe('scoped token 的 write scope 强制', () => {
  // api_tokens 表签发的 token 按 scopes 收窄写操作：
  // 非 GET/HEAD/OPTIONS 且 scopes 不含 write/admin → 403；读操作不受影响。
  // env API_TOKEN / 免鉴权 / web-session（admin）保持全能力。

  function enablePasswordAuth() {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = 'scoped-pw'
    process.env.READ_TOKEN = ''
    process.env.WRITE_TOKEN = ''
  }

  test('read-only token：写 403（forbidden），读 200', async () => {
    enablePasswordAuth()
    const { plain } = createToken('ro-client', ['read'])
    const app = createApp()

    const write = await app.fetch(new Request('http://localhost/api/v1/test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${plain}` },
    }))
    expect(write.status).toBe(403)
    const body = (await write.json()) as { error: string }
    expect(body.error).toBe('forbidden')

    const read = await app.fetch(new Request('http://localhost/api/v1/test', {
      headers: { Authorization: `Bearer ${plain}` },
    }))
    expect(read.status).toBe(200)
  })

  test('read+write token：读写均通', async () => {
    enablePasswordAuth()
    const { plain } = createToken('rw-client', ['read', 'write'])
    const app = createApp()

    const write = await app.fetch(new Request('http://localhost/api/v1/test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${plain}` },
    }))
    expect(write.status).toBe(200)

    const read = await app.fetch(new Request('http://localhost/api/v1/test', {
      headers: { Authorization: `Bearer ${plain}` },
    }))
    expect(read.status).toBe(200)
  })

  test('env API_TOKEN 的写操作不受 scopes 强制影响', async () => {
    process.env.API_TOKEN = 'env-full-token'
    process.env.AUTH_PASSWORD = ''
    process.env.READ_TOKEN = ''
    process.env.WRITE_TOKEN = ''

    const app = createApp()
    const res = await app.fetch(new Request('http://localhost/api/v1/test', {
      method: 'POST',
      headers: { Authorization: 'Bearer env-full-token' },
    }))
    expect(res.status).toBe(200)
  })

  test('web-session（admin scopes）的写操作不受影响', async () => {
    enablePasswordAuth()
    const { plain } = createWebSessionToken(true)

    const app = createApp()
    const res = await app.fetch(new Request('http://localhost/api/v1/test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${plain}` },
    }))
    expect(res.status).toBe(200)
  })
})

describe('/mcp 路径的 scope 推导（按凭证角色，不按 HTTP 方法一刀切）', () => {
  // MCP 工具调用全是 POST：按方法拆分会让只读 token 连 search 都 403。
  // /mcp 改为推导 scopes 放行进会话，写工具门禁下沉到工具层。
  // 非 /mcp 路径行为必须保持不变（回归对照）。

  function createMcpApp() {
    const app = new Hono()
    app.all('/mcp', authMiddleware, (c) => c.json({ scopes: c.get('authScopes') ?? null }))
    app.all('/api/v1/test', authMiddleware, (c) => c.json({ scopes: c.get('authScopes') ?? null }))
    return app
  }

  function post(app: Hono, path: string, token?: string) {
    return app.fetch(new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }))
  }

  test('READ_TOKEN → read；WRITE_TOKEN → admin（POST 均不再 403）', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = ''
    process.env.READ_TOKEN = 'mcp-read'
    process.env.WRITE_TOKEN = 'mcp-write'

    const app = createMcpApp()

    const ro = await post(app, '/mcp', 'mcp-read')
    expect(ro.status).toBe(200)
    expect(((await ro.json()) as { scopes: string[] }).scopes).toEqual(['read'])

    const rw = await post(app, '/mcp', 'mcp-write')
    expect(rw.status).toBe(200)
    expect(((await rw.json()) as { scopes: string[] }).scopes).toEqual(['admin'])

    // 无凭证仍 401
    const anon = await post(app, '/mcp')
    expect(anon.status).toBe(401)

    // 回归：非 /mcp 路径仍按方法拆分（READ_TOKEN 不能写）
    const apiWrite = await post(app, '/api/v1/test', 'mcp-read')
    expect(apiWrite.status).toBe(401)
  })

  test('仅 API_TOKEN（未设 WRITE_TOKEN）→ admin', async () => {
    process.env.API_TOKEN = 'mcp-full'
    process.env.AUTH_PASSWORD = ''
    process.env.READ_TOKEN = ''
    process.env.WRITE_TOKEN = ''

    const app = createMcpApp()
    const res = await post(app, '/mcp', 'mcp-full')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { scopes: string[] }).scopes).toEqual(['admin'])
  })

  test('同时设 WRITE_TOKEN + API_TOKEN（收窄场景）→ API_TOKEN 在 /mcp 得 read', async () => {
    process.env.API_TOKEN = 'mcp-legacy'
    process.env.AUTH_PASSWORD = ''
    process.env.READ_TOKEN = ''
    process.env.WRITE_TOKEN = 'mcp-write'

    const app = createMcpApp()
    const res = await post(app, '/mcp', 'mcp-legacy')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { scopes: string[] }).scopes).toEqual(['read'])

    // 回归：同一 token 在非 /mcp 的写操作仍被拒（收窄语义不变）
    const apiWrite = await post(app, '/api/v1/test', 'mcp-legacy')
    expect(apiWrite.status).toBe(401)
  })

  test('api_tokens 表 read-only token：POST /mcp 放行且保留记录 scopes；非 /mcp 写仍 403（回归）', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = 'scoped-pw'
    process.env.READ_TOKEN = ''
    process.env.WRITE_TOKEN = ''

    const { plain } = createToken('ro-mcp-client', ['read'])
    const app = createMcpApp()

    const mcp = await post(app, '/mcp', plain)
    expect(mcp.status).toBe(200)
    expect(((await mcp.json()) as { scopes: string[] }).scopes).toEqual(['read'])

    const apiWrite = await post(app, '/api/v1/test', plain)
    expect(apiWrite.status).toBe(403)
  })

  test('api_tokens 表 read+write token：POST /mcp 透传记录 scopes', async () => {
    process.env.API_TOKEN = ''
    process.env.AUTH_PASSWORD = 'scoped-pw'
    process.env.READ_TOKEN = ''
    process.env.WRITE_TOKEN = ''

    const { plain } = createToken('rw-mcp-client', ['read', 'write'])
    const app = createMcpApp()
    const mcp = await post(app, '/mcp', plain)
    expect(mcp.status).toBe(200)
    expect(((await mcp.json()) as { scopes: string[] }).scopes).toEqual(['read', 'write'])
  })
})
