import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb } from '../db'
import { createMcpTransport } from '../mcp/server'

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
  transport: Awaited<ReturnType<typeof createMcpTransport>>,
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

describe('createMcpTransport', () => {
  test('transport 可以初始化创建', async () => {
    const transport = await createMcpTransport('test-nb-id')
    expect(transport).toBeDefined()
  })

  test('initialize 返回 session 和 serverInfo', async () => {
    const transport = await createMcpTransport('test-nb-id')
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
    const transport = await createMcpTransport('test-nb-id')
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
    expect(tools.length).toBe(13)

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

    await transport.close()
  })
})
