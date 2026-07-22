import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb } from '../db'
import { createSession } from '../mcp/server'

let testDir: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-mcp-test-'))
  initDb(testDir)
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

function parseSseText(text: string): unknown[] {
  const messages: unknown[] = []
  const events = text.split('\n\n')
  for (const event of events) {
    const dataLine = event.split('\n').find((l) => l.startsWith('data: '))
    if (dataLine) {
      try {
        messages.push(JSON.parse(dataLine.slice(6)))
      } catch { /* ignore */ }
    }
  }
  return messages
}

async function mcpRequest(
  transport: Awaited<ReturnType<typeof createSession>>['transport'],
  method: string,
  params?: unknown,
  id?: number,
  sessionId?: string,
): Promise<{ status: number; sessionId: string; body: unknown[] }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  }
  if (sessionId) {
    headers['Mcp-Session-Id'] = sessionId
  }

  const res = await transport.handleRequest(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        id: id ?? null,
      }),
    }),
  )

  const sid = res.headers.get('Mcp-Session-Id') || sessionId || ''
  const text = await res.text()
  const body = parseSseText(text)

  return { status: res.status, sessionId: sid, body }
}

describe('createSession', () => {
  test('transport 可以初始化创建', async () => {
    const { transport } = await createSession('test-nb-id')
    expect(transport).toBeDefined()
  })

  test('initialize 返回 session 和 serverInfo', async () => {
    const { transport } = await createSession('test-nb-id')
    const init = await mcpRequest(transport, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    }, 1)

    expect(init.status).toBe(200)
    expect(init.sessionId.length).toBeGreaterThan(0)
    expect(init.body.length).toBeGreaterThan(0)

    const msg = init.body[0] as Record<string, unknown>
    expect(msg.result).toBeDefined()
    expect((msg.result as Record<string, unknown>).serverInfo).toBeDefined()
    expect((msg.result as Record<string, unknown>).protocolVersion).toBe('2025-03-26')
  })

  test('初始化后可获取工具列表', async () => {
    const { transport } = await createSession('test-nb-id')
    const init = await mcpRequest(transport, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    }, 1)

    await mcpRequest(transport, 'notifications/initialized', undefined, undefined, init.sessionId)

    const list = await mcpRequest(transport, 'tools/list', undefined, 2, init.sessionId)

    expect(list.status).toBe(200)
    expect(list.body.length).toBeGreaterThan(0)

    const msg = list.body[0] as Record<string, unknown>
    expect(msg.result).toBeDefined()
    const tools = (msg.result as Record<string, unknown>).tools as { name: string }[]
    expect(tools.length).toBe(22)

    const toolNames = tools.map((t) => t.name)
    expect(toolNames).toContain('notefast_search')
    expect(toolNames).toContain('notefast_get_doc')
    expect(toolNames).toContain('notefast_get_block')
    expect(toolNames).toContain('notefast_create_block')
    expect(toolNames).toContain('notefast_update_block')
    expect(toolNames).toContain('notefast_create_doc')
    expect(toolNames).toContain('notefast_get_backlinks')
    expect(toolNames).toContain('notefast_list_docs')
    expect(toolNames).toContain('notefast_list_tags')
    expect(toolNames).toContain('notefast_set_doc_tags')
    expect(toolNames).toContain('notefast_get_doc_tree')
    expect(toolNames).toContain('notefast_export_markdown')
    expect(toolNames).toContain('notefast_semantic_search')
    expect(toolNames).toContain('notefast_suggest_title')
    expect(toolNames).toContain('notefast_chat')
    expect(toolNames).toContain('notefast_autolink_suggestions')
    expect(toolNames).toContain('notefast_autolink_apply')
    expect(toolNames).toContain('notefast_autolink_dismiss')
    expect(toolNames).toContain('notefast_autolink_run')

    await transport.close()
  })
})

describe('notefast_create_doc — 嵌套块 FK 回归', () => {
  /** fenced code / 嵌套 list 的 parent_id 是解析期临时 UUID，必须映射成真实 id，否则 immediate FK 失败 */
  test('create_doc 含 fenced code block + 嵌套 list → 成功且父链正确', async () => {
    const { getDb } = await import('../db')
    const nb = getDb().query('SELECT id FROM notebooks LIMIT 1').get() as { id: string }
    const { transport } = await createSession(nb.id)
    const init = await mcpRequest(transport, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    }, 1)
    await mcpRequest(transport, 'notifications/initialized', undefined, undefined, init.sessionId)

    const markdown = '# x\n```js\nconst a=1;\n```\n\npara\n- item1\n  - item2\n'
    const call = await mcpRequest(transport, 'tools/call', {
      name: 'notefast_create_doc',
      arguments: { title: 'code fk test', markdown },
    }, 2, init.sessionId)

    expect(call.status).toBe(200)
    const msg = call.body[0] as Record<string, unknown>
    const result = msg.result as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBeFalsy()
    const payload = JSON.parse(result.content[0]!.text) as { doc_id: string; block_count: number }
    expect(payload.block_count).toBeGreaterThan(3)

    // code block 的 parent 必须是真实存在的 heading block id
    const rows = getDb().query(
      "SELECT id, parent_id, type FROM blocks WHERE root_id = ? AND id != ?",
    ).all(payload.doc_id, payload.doc_id) as Array<{ id: string; parent_id: string | null; type: string }>
    const ids = new Set(rows.map((r) => r.id).concat(payload.doc_id))
    for (const r of rows) {
      expect(r.parent_id).not.toBeNull()
      expect(ids.has(r.parent_id!)).toBe(true)
    }
    expect(rows.some((r) => r.type === 'code')).toBe(true)

    await transport.close()
  })
})

describe('MCP 工具错误语义统一（isError + error.code）', () => {
  async function callTool(name: string, args: Record<string, unknown>) {
    const { getDb } = await import('../db')
    const nb = getDb().query('SELECT id FROM notebooks LIMIT 1').get() as { id: string }
    const { transport } = await createSession(nb.id)
    const init = await mcpRequest(transport, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    }, 1)
    await mcpRequest(transport, 'notifications/initialized', undefined, undefined, init.sessionId)
    const call = await mcpRequest(transport, 'tools/call', { name, arguments: args }, 2, init.sessionId)
    await transport.close()
    const msg = call.body[0] as Record<string, unknown>
    const result = msg.result as { isError?: boolean; content: Array<{ text: string }> }
    return { result, payload: JSON.parse(result.content[0]!.text) as Record<string, unknown> }
  }

  test('get_doc 不存在 → isError + not_found + data.doc_id', async () => {
    const { result, payload } = await callTool('notefast_get_doc', { doc_id: 'no-such-doc' })
    expect(result.isError).toBe(true)
    const err = payload.error as { code: string; message: string; data: { doc_id: string } }
    expect(err.code).toBe('not_found')
    expect(err.data.doc_id).toBe('no-such-doc')
  })

  test('get_block 不存在 → not_found', async () => {
    const { result, payload } = await callTool('notefast_get_block', { block_id: 'nope' })
    expect(result.isError).toBe(true)
    expect((payload.error as { code: string }).code).toBe('not_found')
  })

  test('get_backlinks 目标不存在 → not_found（不再静默返回空列表）', async () => {
    const { result, payload } = await callTool('notefast_get_backlinks', { block_id: 'ghost' })
    expect(result.isError).toBe(true)
    expect((payload.error as { code: string }).code).toBe('not_found')
  })

  test('create_block 父块不存在 → not_found', async () => {
    const { result, payload } = await callTool('notefast_create_block', { parent_id: 'ghost-parent', type: 'paragraph', content: 'x' })
    expect(result.isError).toBe(true)
    expect((payload.error as { code: string }).code).toBe('not_found')
  })

  test('chat 空 messages → invalid_params', async () => {
    const { result, payload } = await callTool('notefast_chat', { messages: [] })
    expect(result.isError).toBe(true)
    expect((payload.error as { code: string }).code).toBe('invalid_params')
  })

  test('chat context_doc_id 不存在 → not_found（不再静默降级）', async () => {
    const { result, payload } = await callTool('notefast_chat', {
      messages: [{ role: 'user', content: 'hi' }],
      context_doc_id: 'ghost-doc',
    })
    expect(result.isError).toBe(true)
    expect((payload.error as { code: string }).code).toBe('not_found')
  })

  test('chat since 格式错误 → invalid_params（不再静默忽略）', async () => {
    const { result, payload } = await callTool('notefast_chat', {
      messages: [{ role: 'user', content: 'hi' }],
      since: 'not-a-date',
    })
    expect(result.isError).toBe(true)
    expect((payload.error as { code: string }).code).toBe('invalid_params')
  })

  test('autolink_apply 不存在 → not_found', async () => {
    const { result, payload } = await callTool('notefast_autolink_apply', { suggestion_id: 'ghost-sug' })
    expect(result.isError).toBe(true)
    expect((payload.error as { code: string }).code).toBe('not_found')
  })

  test('semantic_search 未配置 embedding → not_configured', async () => {
    const { result, payload } = await callTool('notefast_semantic_search', { query: 'test' })
    expect(result.isError).toBe(true)
    expect((payload.error as { code: string }).code).toBe('not_configured')
  })
})

describe('MCP schema 与 capabilities', () => {
  test('notefast_search limit=-1 → zod 拒绝（不接受负数）', async () => {
    const { getDb } = await import('../db')
    const nb = getDb().query('SELECT id FROM notebooks LIMIT 1').get() as { id: string }
    const { transport } = await createSession(nb.id)
    const init = await mcpRequest(transport, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    }, 1)
    await mcpRequest(transport, 'notifications/initialized', undefined, undefined, init.sessionId)

    const call = await mcpRequest(transport, 'tools/call', {
      name: 'notefast_search',
      arguments: { query: 'test', limit: -1 },
    }, 2, init.sessionId)
    await transport.close()

    const msg = call.body[0] as Record<string, unknown>
    // SDK 对 zod 校验失败返回 JSON-RPC error 或 isError result，两种都不应是正常结果
    const rpcErr = msg.error as { code?: number } | undefined
    if (rpcErr) {
      expect(rpcErr.code).toBe(-32602)
    } else {
      const result = msg.result as { isError?: boolean } | undefined
      expect(result?.isError).toBe(true)
    }
  })

  test('initialize 声明 listChanged: false（工具集静态，不假装推送）', async () => {
    const { getDb } = await import('../db')
    const nb = getDb().query('SELECT id FROM notebooks LIMIT 1').get() as { id: string }
    const { transport } = await createSession(nb.id)
    const init = await mcpRequest(transport, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    }, 1)
    await transport.close()

    const msg = init.body[0] as Record<string, unknown>
    const caps = (msg.result as Record<string, unknown>).capabilities as {
      tools?: { listChanged?: boolean }
      resources?: { listChanged?: boolean }
    }
    expect(caps.tools?.listChanged).toBe(false)
    expect(caps.resources?.listChanged).toBe(false)
  })
})

describe('JSON-RPC 信封错误码（Bug 8）', () => {
  async function rawPost(body: string, sessionId?: string) {
    const { getDb } = await import('../db')
    const { Hono } = await import('hono')
    const { handleMcpRequest } = await import('../mcp/server')
    const nb = getDb().query('SELECT id FROM notebooks LIMIT 1').get() as { id: string }
    const app = new Hono()
    app.all('/mcp', (c) => handleMcpRequest(nb.id, c))
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    }
    if (sessionId) headers['Mcp-Session-Id'] = sessionId
    const res = await app.request('http://localhost/mcp', { method: 'POST', headers, body })
    const text = await res.text()
    let json: { error?: { code: number; message: string } } | null = null
    try { json = JSON.parse(text) } catch { /* 成功响应是 SSE，不是 JSON */ }
    return { status: res.status, text, body: json }
  }

  test('JSON 语法错误 → -32700 Parse error', async () => {
    const r = await rawPost('not json at all')
    expect(r.body?.error?.code).toBe(-32700)
  })

  test('空字符串 → -32700', async () => {
    const r = await rawPost('')
    expect(r.body?.error?.code).toBe(-32700)
  })

  test('缺 jsonrpc 字段 → -32600 Invalid Request（不再误报 -32700）', async () => {
    const r = await rawPost('{"method":"initialize","id":1}')
    expect(r.body?.error?.code).toBe(-32600)
  })

  test('jsonrpc: "1.0" → -32600', async () => {
    const r = await rawPost('{"jsonrpc":"1.0","method":"initialize","id":1}')
    expect(r.body?.error?.code).toBe(-32600)
  })

  test('jsonrpc: null → -32600', async () => {
    const r = await rawPost('{"jsonrpc":null,"method":"initialize","id":1}')
    expect(r.body?.error?.code).toBe(-32600)
  })

  test('缺 method → -32600', async () => {
    const r = await rawPost('{"jsonrpc":"2.0","id":1}')
    expect(r.body?.error?.code).toBe(-32600)
  })

  test('id 为对象 → -32600；id 为字符串则放行', async () => {
    const bad = await rawPost('{"jsonrpc":"2.0","method":"initialize","id":{"x":1}}')
    expect(bad.body?.error?.code).toBe(-32600)
  })

  test('合法信封（initialize）→ 不报信封错误', async () => {
    const r = await rawPost('{"jsonrpc":"2.0","method":"initialize","id":"abc","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}')
    expect(r.status).toBe(200)
    expect(r.body?.error).toBeUndefined()
    expect(r.text).not.toContain('-32700')
    expect(r.text).not.toContain('-32600')
  })
})

describe('notefast_chat top_k 边界（Bug 6 附验）', () => {
  test('top_k=21 超出上限 → zod 拒绝；top_k=20 是合法上限值', async () => {
    const { getDb } = await import('../db')
    const nb = getDb().query('SELECT id FROM notebooks LIMIT 1').get() as { id: string }
    const { transport } = await createSession(nb.id)
    const init = await mcpRequest(transport, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    }, 1)
    await mcpRequest(transport, 'notifications/initialized', undefined, undefined, init.sessionId)

    const call = await mcpRequest(transport, 'tools/call', {
      name: 'notefast_chat',
      arguments: { messages: [{ role: 'user', content: 'hi' }], top_k: 21 },
    }, 2, init.sessionId)
    await transport.close()

    const msg = call.body[0] as Record<string, unknown>
    const rpcErr = msg.error as { code?: number } | undefined
    if (rpcErr) {
      expect(rpcErr.code).toBe(-32602)
    } else {
      const result = msg.result as { isError?: boolean } | undefined
      expect(result?.isError).toBe(true)
    }
  })
})
