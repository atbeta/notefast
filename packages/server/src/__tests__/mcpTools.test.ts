import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { initDb, closeDb } from '../db'
import { registerMcpTools } from '../mcp/tools'
import mcpRouter from '../api/mcp'

describe('MCP 工具清单（GET /api/v1/mcp/tools）', () => {
  let testDir: string
  let app: Hono

  beforeAll(() => {
    testDir = mkdtempSync(join('/tmp', 'notefast-mcp-'))
    const { notebookId } = initDb(testDir)
    // 走真实注册路径：registerMcpTools 在注册时收集工具名/描述
    registerMcpTools(new McpServer({ name: 'notefast-test', version: '0.0.0' }), notebookId)
    app = new Hono()
    app.route('/api/v1/mcp', mcpRouter)
  })

  afterAll(() => {
    closeDb()
    rmSync(testDir, { recursive: true, force: true })
  })

  async function fetchTools(): Promise<Array<{ name: string; description: string }>> {
    const res = await app.request('/api/v1/mcp/tools')
    expect(res.status).toBe(200)
    return (await res.json()) as Array<{ name: string; description: string }>
  }

  test('返回注册的全部工具（notefast_ 前缀），含搜索与 AI 能力', async () => {
    const tools = await fetchTools()
    expect(tools.length).toBeGreaterThan(10)
    expect(tools.every((t) => t.name.startsWith('notefast_') && typeof t.description === 'string')).toBe(true)
    for (const name of ['notefast_search', 'notefast_get_doc', 'notefast_create_doc', 'notefast_chat', 'notefast_semantic_search']) {
      expect(tools.some((t) => t.name === name)).toBe(true)
    }
  })

  test('重复注册不叠加（resetMcpToolRegistry 幂等）', async () => {
    const before = (await fetchTools()).length
    registerMcpTools(new McpServer({ name: 'notefast-test', version: '0.0.0' }), 'nb')
    const after = (await fetchTools()).length
    expect(after).toBe(before)
  })
})
