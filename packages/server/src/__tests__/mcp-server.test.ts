import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb } from '../db'
import { createSession } from '../mcp/server'
import { _setRuntimeForTests } from '../services/aiRuntime'

let testDir: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-mcp-test-'))
  initDb(testDir)
  // 隔离：bun 跨测试文件共享模块状态且文件执行顺序随平台变化，
  // 其他文件可能残留带 mock fetch 的 AI runtime，导致 not_configured 断言被污染
  _setRuntimeForTests(null)
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
    expect(tools.length).toBe(35)

    const toolNames = tools.map((t) => t.name)
    expect(toolNames).toContain('notefast_search')
    expect(toolNames).toContain('notefast_get_doc')
    expect(toolNames).toContain('notefast_get_block')
    expect(toolNames).toContain('notefast_create_block')
    expect(toolNames).toContain('notefast_update_block')
    expect(toolNames).toContain('notefast_create_doc')
    expect(toolNames).toContain('notefast_stage_markdown')
    expect(toolNames).toContain('notefast_create_doc_from_file')
    expect(toolNames).toContain('notefast_get_backlinks')
    expect(toolNames).toContain('notefast_list_docs')
    expect(toolNames).toContain('notefast_list_tags')
    expect(toolNames).toContain('notefast_set_doc_tags')
    expect(toolNames).toContain('notefast_get_doc_tree')
    expect(toolNames).toContain('notefast_export_markdown')
    expect(toolNames).toContain('notefast_semantic_search')
    expect(toolNames).toContain('notefast_suggest_title')
    expect(toolNames).toContain('notefast_chat')
    expect(toolNames).toContain('notefast_autolink_run')
    expect(toolNames).toContain('notefast_share_doc')
    expect(toolNames).toContain('notefast_get_share')
    expect(toolNames).toContain('notefast_unshare_doc')
    expect(toolNames).toContain('notefast_delete_doc')
    expect(toolNames).toContain('notefast_delete_block')
    expect(toolNames).toContain('notefast_move_block')
    expect(toolNames).toContain('notefast_list_revisions')
    expect(toolNames).toContain('notefast_create_ref')
    expect(toolNames).toContain('notefast_delete_ref')
    expect(toolNames).toContain('notefast_list_pinned_views')
    expect(toolNames).toContain('notefast_pin_view')
    expect(toolNames).toContain('notefast_unpin_view')
    // 三态审核工具已随「高置信直接建链」模型下线
    expect(toolNames).not.toContain('notefast_autolink_suggestions')
    expect(toolNames).not.toContain('notefast_autolink_apply')
    expect(toolNames).not.toContain('notefast_autolink_dismiss')
    expect(toolNames).not.toContain('notefast_autolink_revert')

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

  test('create_block notebook 不存在 → isError + not_found（不再被二次包装成成功）', async () => {
    const { result, payload } = await callTool('notefast_create_block', {
      notebook_id: 'ghost-nb',
      type: 'paragraph',
      content: 'x',
    })
    expect(result.isError).toBe(true)
    expect((payload.error as { code: string }).code).toBe('not_found')
  })

  test('create_doc notebook 不存在 → isError + not_found（不再被二次包装成成功）', async () => {
    const { result, payload } = await callTool('notefast_create_doc', {
      notebook_id: 'ghost-nb',
      title: 't',
      markdown: 'hello',
    })
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

  test('semantic_search 未配置 embedding → not_configured', async () => {
    const { result, payload } = await callTool('notefast_semantic_search', { query: 'test' })
    expect(result.isError).toBe(true)
    expect((payload.error as { code: string }).code).toBe('not_configured')
  })
})

describe('MCP ai_exclude 一致性（对 AI 隐藏）', () => {
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

  async function setupExcludedDoc(): Promise<{ excludedDocId: string; excludedChildId: string; normalDocId: string }> {
    const { getDb, initDb } = await import('../db')
    initDb(testDir) // 确保已初始化
    const db = getDb()
    const nb = db.query('SELECT id FROM notebooks LIMIT 1').get() as { id: string }
    const excludedDocId = crypto.randomUUID()
    const excludedChildId = crypto.randomUUID()
    const normalDocId = crypto.randomUUID()
    const now = new Date().toISOString()

    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'document', 'secret', 0, 0, ?, ?)`,
    ).run(excludedDocId, nb.id, excludedDocId, now, now)
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'paragraph', 'secret-para', 0, 1, ?, ?)`,
    ).run(excludedChildId, nb.id, excludedDocId, excludedDocId, now, now)
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'document', 'public', 0, 0, ?, ?)`,
    ).run(normalDocId, nb.id, normalDocId, now, now)

    // 用 REST 端点写入 properties，避免直接拼 JSON
    const { default: docs } = await import('../api/docs')
    const { Hono } = await import('hono')
    const app = new Hono()
    app.route('/api/v1/docs', docs)
    await app.request(`http://localhost/api/v1/docs/${excludedDocId}/ai-exclude`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ai_exclude: true }),
    })

    return { excludedDocId, excludedChildId, normalDocId }
  }

  test('get_doc 对 ai_exclude 文档 → forbidden', async () => {
    const { excludedDocId } = await setupExcludedDoc()
    const { result, payload } = await callTool('notefast_get_doc', { doc_id: excludedDocId })
    expect(result.isError).toBe(true)
    expect((payload.error as { code: string }).code).toBe('forbidden')
  })

  test('update_block 对 ai_exclude 文档子块 → forbidden', async () => {
    const { excludedChildId } = await setupExcludedDoc()
    const { result, payload } = await callTool('notefast_update_block', {
      block_id: excludedChildId,
      content: 'tampered',
    })
    expect(result.isError).toBe(true)
    expect((payload.error as { code: string }).code).toBe('forbidden')
  })

  test('create_block 父块属于 ai_exclude 文档 → forbidden', async () => {
    const { excludedChildId } = await setupExcludedDoc()
    const { result, payload } = await callTool('notefast_create_block', {
      parent_id: excludedChildId,
      type: 'paragraph',
      content: 'injected',
    })
    expect(result.isError).toBe(true)
    expect((payload.error as { code: string }).code).toBe('forbidden')
  })

  test('list_docs 不返回 ai_exclude 文档', async () => {
    const { excludedDocId } = await setupExcludedDoc()
    const { result, payload } = await callTool('notefast_list_docs', {})
    expect(result.isError).toBeFalsy()
    const ids = ((payload.docs as Array<{ id: string }>) ?? []).map((d) => d.id)
    expect(ids).not.toContain(excludedDocId)
  })

  test('export_markdown 对 ai_exclude 文档 → forbidden', async () => {
    const { excludedDocId } = await setupExcludedDoc()
    const { result, payload } = await callTool('notefast_export_markdown', { doc_id: excludedDocId })
    expect(result.isError).toBe(true)
    expect((payload.error as { code: string }).code).toBe('forbidden')
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

describe('notefast 实体工具（E3）', () => {
  async function setupEntity() {
    const { getDb } = await import('../db')
    const db = getDb()
    const nbRow = db.query('SELECT id FROM notebooks LIMIT 1').get() as { id: string }
    const nb = nbRow.id
    const docId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, status, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'document', '向量检索实践', 'note', 0, 0, ?, ?)`,
    ).run(docId, nb, docId, now, now)
    const bid = crypto.randomUUID()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'paragraph', '向量数据库与混合检索的选型对比', 0, 1, ?, ?)`,
    ).run(bid, nb, docId, docId, now, now)
    const eid = crypto.randomUUID()
    db.query(
      `INSERT INTO entities (id, name, display, kind, mention_count, description)
       VALUES (?, '向量数据库', '向量数据库', 'concept', 1, NULL)`,
    ).run(eid)
    db.query(
      `INSERT INTO entity_mentions (entity_id, block_id, surface) VALUES (?, ?, '向量数据库')`,
    ).run(eid, bid)
    return { nb, docId, entityId: eid }
  }

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
    const payload = result?.content?.[0]?.text ? JSON.parse(result.content[0].text) : null
    return { result, payload }
  }

  test('工具已注册', async () => {
    const { getDb } = await import('../db')
    const nb = getDb().query('SELECT id FROM notebooks LIMIT 1').get() as { id: string }
    const { transport } = await createSession(nb.id)
    const init = await mcpRequest(transport, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    }, 1)
    const call = await mcpRequest(transport, 'tools/list', {}, 2, init.sessionId)
    await transport.close()
    const msg = call.body[0] as { result?: { tools?: Array<{ name: string }> } }
    const names = (msg.result?.tools ?? []).map((t) => t.name)
    expect(names).toContain('notefast_search_entities')
    expect(names).toContain('notefast_get_entity_notes')
  })

  test('search_entities 返回实体（含描述）；get_entity_notes 返回笔记；实体不存在 404', async () => {
    await setupEntity()
    const search = await callTool('notefast_search_entities', { query: '向量' })
    expect(search.result.isError).toBeFalsy()
    const found = search.payload.entities as Array<{ id: string; display: string; mention_count: number }>
    expect(found.length).toBe(1)
    expect(found[0]!.display).toBe('向量数据库')

    const notes = await callTool('notefast_get_entity_notes', { entity_id: found[0]!.id })
    expect(notes.result.isError).toBeFalsy()
    const noteList = notes.payload.notes as Array<{ doc_id: string; doc_status: string; snippet: string }>
    expect(noteList.length).toBe(1)
    expect(noteList[0]!.doc_status).toBe('note')

    const missing = await callTool('notefast_get_entity_notes', { entity_id: 'ghost' })
    expect(missing.result.isError).toBe(true)
    expect((missing.payload.error as { code: string }).code).toBe('not_found')
  })
})

describe('MCP 写入的 actor 标注（历史面板可识别）', () => {
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

  test('update_block 成功 → block_revisions 最新条 actor=mcp', async () => {
    const { getDb } = await import('../db')
    const db = getDb()
    const nb = db.query('SELECT id FROM notebooks LIMIT 1').get() as { id: string }
    const { insertDocFromMarkdown } = await import('../services/docImport')
    const created = insertDocFromMarkdown(db, { notebookId: nb.id, title: 'MCP actor 测试', markdown: '原始内容' })
    const blockId = created.blockIds[0]!

    const { result } = await callTool('notefast_update_block', { block_id: blockId, content: 'MCP 改的内容' })
    expect(result.isError).toBeFalsy()

    const rev = db.query(
      `SELECT actor FROM block_revisions WHERE block_id = ? ORDER BY rev DESC LIMIT 1`,
    ).get(blockId) as { actor: string } | undefined
    expect(rev?.actor).toBe('mcp')
  })

  test('update_block 子块 → 文档根 updated_at 冒泡更新（列表「最近更新」语义）', async () => {
    const { getDb } = await import('../db')
    const db = getDb()
    const nb = db.query('SELECT id FROM notebooks LIMIT 1').get() as { id: string }
    const { insertDocFromMarkdown } = await import('../services/docImport')
    const created = insertDocFromMarkdown(db, { notebookId: nb.id, title: 'MCP 冒泡测试', markdown: '原始内容' })
    const blockId = created.blockIds[0]!
    const rootU = () =>
      (db.query('SELECT updated_at FROM blocks WHERE id = ?').get(created.docId) as { updated_at: string }).updated_at

    const t0 = rootU()
    await new Promise((r) => setTimeout(r, 10)) // SQL_NOW 毫秒精度，确保有差异窗口
    const { result } = await callTool('notefast_update_block', { block_id: blockId, content: 'MCP 改的' })
    expect(result.isError).toBeFalsy()
    expect(rootU() > t0).toBe(true)
  })
})

describe('notefast 分享工具（公开只读链接）', () => {
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
    const payload = result?.content?.[0]?.text ? JSON.parse(result.content[0].text) : null
    return { result, payload }
  }

  async function setupDoc(title = 'MCP 分享测试'): Promise<string> {
    const { getDb } = await import('../db')
    const db = getDb()
    const nb = db.query('SELECT id FROM notebooks LIMIT 1').get() as { id: string }
    const docId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, status, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'document', ?, 'note', 0, 0, ?, ?)`,
    ).run(docId, nb.id, docId, title, now, now)
    return docId
  }

  test('工具已注册', async () => {
    const { getDb } = await import('../db')
    const nb = getDb().query('SELECT id FROM notebooks LIMIT 1').get() as { id: string }
    const { transport } = await createSession(nb.id)
    const init = await mcpRequest(transport, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    }, 1)
    const call = await mcpRequest(transport, 'tools/list', {}, 2, init.sessionId)
    await transport.close()
    const msg = call.body[0] as { result?: { tools?: Array<{ name: string }> } }
    const names = (msg.result?.tools ?? []).map((t) => t.name)
    expect(names).toContain('notefast_share_doc')
    expect(names).toContain('notefast_get_share')
    expect(names).toContain('notefast_unshare_doc')
  })

  test('开启幂等同 token；get_share 查询；带 expires_in_days 调整有效期', async () => {
    const docId = await setupDoc()

    // 未开启时查询
    const before = await callTool('notefast_get_share', { doc_id: docId })
    expect(before.result.isError).toBeFalsy()
    expect(before.payload.shared).toBe(false)

    // 开启
    const created = await callTool('notefast_share_doc', { doc_id: docId })
    expect(created.result.isError).toBeFalsy()
    expect(created.payload.shared).toBe(true)
    expect(created.payload.path).toBe(`/s/${created.payload.token}`)
    expect(created.payload.expires_at).toBeNull()

    // 幂等：重复开启返回同一 token
    const again = await callTool('notefast_share_doc', { doc_id: docId })
    expect(again.payload.token).toBe(created.payload.token)

    // 已开启时带 expires_in_days = 调整有效期（以现在为起点）
    const adjusted = await callTool('notefast_share_doc', { doc_id: docId, expires_in_days: 7 })
    expect(adjusted.payload.token).toBe(created.payload.token)
    expect(typeof adjusted.payload.expires_at).toBe('string')
    const deltaMs = new Date(adjusted.payload.expires_at as string).getTime() - Date.now()
    expect(deltaMs).toBeGreaterThan(6 * 86_400_000)
    expect(deltaMs).toBeLessThan(8 * 86_400_000)
  })

  test('关闭幂等；重新开启生成全新 token', async () => {
    const docId = await setupDoc('MCP 分享关闭测试')
    const created = await callTool('notefast_share_doc', { doc_id: docId })

    const closed = await callTool('notefast_unshare_doc', { doc_id: docId })
    expect(closed.result.isError).toBeFalsy()
    expect(closed.payload.deleted).toBe(true)

    // 幂等：本就没开启也成功
    const again = await callTool('notefast_unshare_doc', { doc_id: docId })
    expect(again.result.isError).toBeFalsy()

    const after = await callTool('notefast_get_share', { doc_id: docId })
    expect(after.payload.shared).toBe(false)

    // 重开全新 token，旧链接永久失效
    const reopened = await callTool('notefast_share_doc', { doc_id: docId })
    expect(reopened.payload.token).not.toBe(created.payload.token)
  })

  test('文档不存在 → not_found；ai_exclude 文档 → forbidden', async () => {
    const missing = await callTool('notefast_share_doc', { doc_id: 'no-such-doc' })
    expect(missing.result.isError).toBe(true)
    expect((missing.payload.error as { code: string }).code).toBe('not_found')

    // ai_exclude 文档：MCP 一律 forbidden，无 confirm 通道
    const excludedId = await setupDoc('secret-share')
    const { default: docs } = await import('../api/docs')
    const { Hono } = await import('hono')
    const app = new Hono()
    app.route('/api/v1/docs', docs)
    await app.request(`http://localhost/api/v1/docs/${excludedId}/ai-exclude`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ai_exclude: true }),
    })

    const denied = await callTool('notefast_share_doc', { doc_id: excludedId })
    expect(denied.result.isError).toBe(true)
    expect((denied.payload.error as { code: string }).code).toBe('forbidden')
  })
})

describe('notefast_delete_doc（软删除，回收站可恢复）', () => {
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
    const payload = result?.content?.[0]?.text ? JSON.parse(result.content[0].text) : null
    return { result, payload }
  }

  async function setupDoc(title = 'MCP 删除测试'): Promise<string> {
    const { getDb } = await import('../db')
    const db = getDb()
    const nb = db.query('SELECT id FROM notebooks LIMIT 1').get() as { id: string }
    const docId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, status, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'document', ?, 'note', 0, 0, ?, ?)`,
    ).run(docId, nb.id, docId, title, now, now)
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'paragraph', '正文', 0, 1, ?, ?)`,
    ).run(crypto.randomUUID(), nb.id, docId, docId, now, now)
    return docId
  }

  test('删除整篇（含子块）；list_docs 不再可见；list_deleted 可见；restore 恢复；重复删除 not_found', async () => {
    const docId = await setupDoc()

    const del = await callTool('notefast_delete_doc', { doc_id: docId })
    expect(del.result.isError).toBeFalsy()
    expect(del.payload.deleted).toBe(true)
    expect(del.payload.count).toBe(2) // 文档根 + 子块

    // 主列表不可见
    const list = await callTool('notefast_list_docs', {})
    const ids = (list.payload.docs as Array<{ id: string }>).map((d) => d.id)
    expect(ids).not.toContain(docId)

    // 回收站（list_deleted）可见
    const deleted = await callTool('notefast_list_deleted', {})
    const deletedIds = (deleted.payload.blocks as Array<{ id: string }>).map((b) => b.id)
    expect(deletedIds).toContain(docId)

    // 恢复后回到列表
    const restored = await callTool('notefast_restore_block', { block_id: docId })
    expect(restored.result.isError).toBeFalsy()
    const listAfter = await callTool('notefast_list_docs', {})
    const idsAfter = (listAfter.payload.docs as Array<{ id: string }>).map((d) => d.id)
    expect(idsAfter).toContain(docId)

    // 重复删除 = 文档（活）不存在
    const again = await callTool('notefast_delete_doc', { doc_id: docId })
    expect(again.result.isError).toBeFalsy() // 恢复后可再次删除
    const ghost = await callTool('notefast_delete_doc', { doc_id: 'no-such-doc' })
    expect(ghost.result.isError).toBe(true)
    expect((ghost.payload.error as { code: string }).code).toBe('not_found')
  })

  test('ai_exclude 文档 → forbidden；删除级联关闭分享', async () => {
    // ai_exclude：MCP 一律 forbidden
    const excludedId = await setupDoc('secret-delete')
    const { default: docs } = await import('../api/docs')
    const { Hono } = await import('hono')
    const app = new Hono()
    app.route('/api/v1/docs', docs)
    await app.request(`http://localhost/api/v1/docs/${excludedId}/ai-exclude`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ai_exclude: true }),
    })
    const denied = await callTool('notefast_delete_doc', { doc_id: excludedId })
    expect(denied.result.isError).toBe(true)
    expect((denied.payload.error as { code: string }).code).toBe('forbidden')

    // 级联关闭分享：删除后分享记录清除，恢复不复活旧 token
    const docId = await setupDoc('级联分享测试')
    await callTool('notefast_share_doc', { doc_id: docId })
    await callTool('notefast_delete_doc', { doc_id: docId })
    const { getDb } = await import('../db')
    const row = getDb().query('SELECT doc_id FROM shares WHERE doc_id = ?').get(docId)
    expect(row).toBeNull()
  })
})

describe('MCP create_doc 不从 YAML 发明标签', () => {
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

  const yamlMd = '---\ntags:\n  - invented\n  - extra\n---\n\n正文'

  test('markdown 含 YAML tags、未传 tags → 入库无标签', async () => {
    const { result, payload } = await callTool('notefast_create_doc', {
      title: '无指定标签',
      markdown: yamlMd,
    })
    expect(result.isError).toBeFalsy()
    const { getDb } = await import('../db')
    const { getBlockById } = await import('../store/blocks')
    const { readTags } = await import('@notefast/core')
    expect(readTags(getBlockById(getDb(), payload.doc_id as string)!)).toEqual([])
  })

  test('显式 tags 参数生效', async () => {
    const { result, payload } = await callTool('notefast_create_doc', {
      title: '指定标签',
      markdown: yamlMd,
      tags: ['work'],
    })
    expect(result.isError).toBeFalsy()
    const { getDb } = await import('../db')
    const { getBlockById } = await import('../store/blocks')
    const { readTags } = await import('@notefast/core')
    expect(readTags(getBlockById(getDb(), payload.doc_id as string)!)).toEqual(['work'])
  })
})

describe('MCP 固定视图', () => {
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

  test('pin → list → unpin', async () => {
    const pin = await callTool('notefast_pin_view', { name: '工作', tags: ['work'] })
    expect(pin.result.isError).toBeFalsy()
    expect(pin.payload.query).toBe('tags=work')
    expect(pin.payload.created).toBe(true)
    const id = pin.payload.id as string

    const listed = await callTool('notefast_list_pinned_views', {})
    expect(listed.result.isError).toBeFalsy()
    const views = listed.payload.views as Array<{ id: string; query: string }>
    expect(views.some((v) => v.id === id && v.query === 'tags=work')).toBe(true)

    const un = await callTool('notefast_unpin_view', { id })
    expect(un.result.isError).toBeFalsy()
    expect(un.payload.deleted).toBe(true)

    const missing = await callTool('notefast_unpin_view', { id: 'no-such-view' })
    expect(missing.result.isError).toBe(true)
    expect((missing.payload.error as { code: string }).code).toBe('not_found')
  })

  test('无筛选 → invalid_params', async () => {
    const { result, payload } = await callTool('notefast_pin_view', { name: '空' })
    expect(result.isError).toBe(true)
    expect((payload.error as { code: string }).code).toBe('invalid_params')
  })
})
