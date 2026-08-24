import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { initDb, closeDb } from '../db'
import { createSession } from '../mcp/server'
import { _setRuntimeForTests } from '../services/aiRuntime'
import mcpRouter from '../api/mcp'

let testDir: string
let notebookId: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-mcp-scopes-'))
  notebookId = initDb(testDir).notebookId
  _setRuntimeForTests(null)
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

function parseSseText(text: string): unknown[] {
  const messages: unknown[] = []
  for (const event of text.split('\n\n')) {
    const dataLine = event.split('\n').find((l) => l.startsWith('data: '))
    if (dataLine) {
      try { messages.push(JSON.parse(dataLine.slice(6))) } catch { /* ignore */ }
    }
  }
  return messages
}

/** 以指定 scopes 建立会话，返回 tools/call 闭包（测完需 close transport） */
async function openSession(scopes: string[]) {
  const { transport } = await createSession(notebookId, scopes)

  async function rpc(method: string, params?: unknown, id?: number, sessionId?: string) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    }
    if (sessionId) headers['Mcp-Session-Id'] = sessionId
    const res = await transport.handleRequest(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: id ?? null }),
      }),
    )
    return { sessionId: res.headers.get('Mcp-Session-Id') || sessionId || '', body: parseSseText(await res.text()) }
  }

  const init = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0' },
  }, 1)
  await rpc('notifications/initialized', undefined, undefined, init.sessionId)

  async function callTool(name: string, args: Record<string, unknown>) {
    const call = await rpc('tools/call', { name, arguments: args }, 2, init.sessionId)
    const msg = call.body[0] as Record<string, unknown>
    const result = msg.result as { isError?: boolean; content: Array<{ text: string }> }
    const payload = result?.content?.[0]?.text ? JSON.parse(result.content[0].text) as Record<string, unknown> : null
    return { result, payload }
  }

  return { transport, rpc, callTool, sessionId: init.sessionId }
}

describe('MCP 只读 scope 的工具层门禁', () => {
  test("scopes=['read']：写工具 forbidden（不触达 handler），只读工具正常", async () => {
    const { transport, callTool } = await openSession(['read'])

    // 写工具：block 不存在也应先被门禁挡住（forbidden 而非 not_found，证明没进 handler）
    const write = await callTool('notefast_update_block', { block_id: 'any', content: 'x' })
    expect(write.result.isError).toBe(true)
    const err = write.payload!.error as { code: string; message: string; data: { tool: string } }
    expect(err.code).toBe('forbidden')
    expect(err.message).toContain('只读')
    expect(err.data.tool).toBe('notefast_update_block')

    for (const [name, args] of [
      ['notefast_create_block', { type: 'paragraph', content: 'x' }],
      ['notefast_create_doc', { title: 't', markdown: 'm' }],
      ['notefast_stage_markdown', { chunk: 'x' }],
      ['notefast_set_doc_tags', { doc_id: 'x', tags: [] }],
      ['notefast_delete_doc', { doc_id: 'x' }],
      ['notefast_delete_block', { block_id: 'x' }],
      ['notefast_move_block', { block_id: 'x', new_parent_id: null }],
      ['notefast_create_ref', { source_id: 'a', target_id: 'b' }],
      ['notefast_delete_ref', { source_id: 'a', target_id: 'b' }],
      ['notefast_restore_block', { block_id: 'x' }],
      ['notefast_autolink_run', { block_id: 'x' }],
      ['notefast_share_doc', { doc_id: 'x' }],
      ['notefast_unshare_doc', { doc_id: 'x' }],
      // chat 的 agent loop 内含写工具循环，按写处理
      ['notefast_chat', { messages: [{ role: 'user', content: 'hi' }] }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await callTool(name, args)
      expect(r.result.isError).toBe(true)
      expect((r.payload!.error as { code: string }).code).toBe('forbidden')
    }

    // 只读工具照常可用
    const search = await callTool('notefast_search', { query: '测试' })
    expect(search.result.isError).toBeFalsy()
    const listDocs = await callTool('notefast_list_docs', {})
    expect(listDocs.result.isError).toBeFalsy()
    const listTags = await callTool('notefast_list_tags', {})
    expect(listTags.result.isError).toBeFalsy()
    const listDeleted = await callTool('notefast_list_deleted', {})
    expect(listDeleted.result.isError).toBeFalsy()
    // 新只读工具同样放行（目标不存在走到 handler 的 not_found，证明没被门禁拦）
    const revisions = await callTool('notefast_list_revisions', { block_id: 'ghost' })
    expect(revisions.result.isError).toBe(true)
    expect((revisions.payload!.error as { code: string }).code).toBe('not_found')

    await transport.close()
  })

  test("scopes=['admin'] 与 ['write']：写工具可用（进到 handler 的 not_found）", async () => {
    for (const scopes of [['admin'], ['write']]) {
      const { transport, callTool } = await openSession(scopes)
      // block 不存在 → not_found，证明越过了门禁进了 handler
      const r = await callTool('notefast_update_block', { block_id: 'ghost', content: 'x' })
      expect(r.result.isError).toBe(true)
      expect((r.payload!.error as { code: string }).code).toBe('not_found')
      await transport.close()
    }
  })

  test("scopes=[]（未经 authMiddleware 的直连缺省）：按只读处理", async () => {
    const { transport, callTool } = await openSession([])
    const r = await callTool('notefast_delete_doc', { doc_id: 'x' })
    expect(r.result.isError).toBe(true)
    expect((r.payload!.error as { code: string }).code).toBe('forbidden')
    await transport.close()
  })

  test('tools/list 仍列全量工具，且 annotations 标注读写性', async () => {
    const { transport, rpc, sessionId } = await openSession(['read'])
    const list = await rpc('tools/list', undefined, 3, sessionId)
    await transport.close()

    const msg = list.body[0] as { result: { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }> } }
    const tools = msg.result.tools
    expect(tools.length).toBe(32)
    // 每个工具都有 readOnlyHint 标注
    for (const t of tools) {
      expect(typeof t.annotations?.readOnlyHint).toBe('boolean')
    }
    const byName = new Map(tools.map((t) => [t.name, t.annotations!]))
    expect(byName.get('notefast_search')!.readOnlyHint).toBe(true)
    expect(byName.get('notefast_list_deleted')!.readOnlyHint).toBe(true)
    expect(byName.get('notefast_list_revisions')!.readOnlyHint).toBe(true)
    expect(byName.get('notefast_update_block')!.readOnlyHint).toBe(false)
    expect(byName.get('notefast_chat')!.readOnlyHint).toBe(false)
    expect(byName.get('notefast_delete_doc')!.readOnlyHint).toBe(false)
    expect(byName.get('notefast_delete_doc')!.destructiveHint).toBe(true)
    expect(byName.get('notefast_move_block')!.readOnlyHint).toBe(false)
    expect(byName.get('notefast_create_ref')!.readOnlyHint).toBe(false)
    expect(byName.get('notefast_delete_ref')!.readOnlyHint).toBe(false)
    expect(byName.get('notefast_delete_block')!.readOnlyHint).toBe(false)
    expect(byName.get('notefast_delete_block')!.destructiveHint).toBe(true)
  })
})

describe('GET /api/v1/mcp/tools 注册表带 readOnly 字段', () => {
  test('条目含 readOnly；搜索只读、update_block 可写', async () => {
    // 注册表是进程级共享状态：任一测试文件先注册都会填入（条目必带 readOnly）。
    // 若本文件先跑且尚未注册，则主动补一次注册保证非空。
    const { mcpToolRegistry, resetMcpToolRegistry } = await import('../mcp/tools/helpers')
    if (mcpToolRegistry.length === 0) {
      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
      const { registerMcpTools } = await import('../mcp/tools')
      resetMcpToolRegistry()
      registerMcpTools(new McpServer({ name: 't', version: '0' }), notebookId)
    }

    const app = new Hono()
    app.route('/api/v1/mcp', mcpRouter)
    const res = await app.request('/api/v1/mcp/tools')
    expect(res.status).toBe(200)
    const tools = (await res.json()) as Array<{ name: string; description: string; readOnly: boolean }>
    expect(tools.length).toBeGreaterThan(10)
    const byName = new Map(tools.map((t) => [t.name, t]))
    expect(byName.get('notefast_search')!.readOnly).toBe(true)
    expect(byName.get('notefast_get_share')!.readOnly).toBe(true)
    expect(byName.get('notefast_update_block')!.readOnly).toBe(false)
    expect(byName.get('notefast_delete_doc')!.readOnly).toBe(false)
    expect(byName.get('notefast_chat')!.readOnly).toBe(false)
  })
})

describe('会话 scopes 每请求刷新（门禁惰性读取）', () => {
  test('同一会话内降权 read → 写工具立即 forbidden；升回 admin → 立即恢复', async () => {
    let scopes = ['admin']
    const { handleMcpRequest } = await import('../mcp/server')
    const app = new Hono()
    app.use('/mcp', async (c, next) => {
      c.set('authScopes', scopes)
      await next()
    })
    app.all('/mcp', (c) => handleMcpRequest(notebookId, c))

    async function rpc(method: string, params?: unknown, id?: number, sessionId?: string) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      }
      if (sessionId) headers['Mcp-Session-Id'] = sessionId
      const res = await app.request('/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: id ?? null }),
      })
      return { sessionId: res.headers.get('Mcp-Session-Id') || sessionId || '', body: parseSseText(await res.text()) }
    }
    const errCodeOf = (body: unknown[]): string => {
      const msg = body[0] as { result: { content: Array<{ text: string }> } }
      const payload = JSON.parse(msg.result.content[0]!.text) as { error: { code: string } }
      return payload.error.code
    }

    const init = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    }, 1)
    const sid = init.sessionId
    await rpc('notifications/initialized', undefined, undefined, sid)
    const callWrite = () => rpc('tools/call', { name: 'notefast_update_block', arguments: { block_id: 'ghost-lazy', content: 'x' } }, 2, sid)

    // admin：过门禁进 handler → 块不存在 not_found（证明没被门禁拦）
    expect(errCodeOf((await callWrite()).body)).toBe('not_found')
    // 同一会话降权 read：立即 forbidden（不等会话 TTL / 重启）
    scopes = ['read']
    expect(errCodeOf((await callWrite()).body)).toBe('forbidden')
    // 升回 admin：立即恢复
    scopes = ['admin']
    expect(errCodeOf((await callWrite()).body)).toBe('not_found')
  })
})
