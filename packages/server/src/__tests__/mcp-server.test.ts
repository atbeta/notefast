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
    expect(tools.length).toBe(20)

    const toolNames = tools.map((t) => t.name)
    expect(toolNames).toContain('notefast_search')
    expect(toolNames).toContain('notefast_get_doc')
    expect(toolNames).toContain('notefast_get_block')
    expect(toolNames).toContain('notefast_create_block')
    expect(toolNames).toContain('notefast_update_block')
    expect(toolNames).toContain('notefast_create_doc')
    expect(toolNames).toContain('notefast_get_backlinks')
    expect(toolNames).toContain('notefast_list_docs')
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
