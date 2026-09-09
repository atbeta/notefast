/**
 * MCP vault 工具：notefast_vault_status / notefast_vault_rebuild /
 * notefast_create_doc(path) / notefast_get_doc(vault_path)。
 *
 * 走真实 MCP 会话（createSession + transport），与 mcpBlockOps 同一套路。
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb, getDb } from '../db'
import { createSession } from '../mcp/server'
import { _setRuntimeForTests } from '../services/aiRuntime'
import { getBlockById } from '../store/blocks'
import { getVaultFileByPath } from '../store/vaultFiles'
import { DEFAULT_VAULT_IGNORE, type VaultConfig } from '../vault/config'
import { createVaultRuntime, type VaultRuntime } from '../vault'

let testDir: string
let vaultDir: string
let notebookId: string
let runtime: VaultRuntime

function makeConfig(root: string): VaultConfig {
  return {
    root,
    ignore: [...DEFAULT_VAULT_IGNORE],
    watch: false,
    writeback: false,
    stabilityMs: 50,
    usePolling: true,
    pollIntervalMs: 50,
    reconcileMinutes: 0,
  }
}

function parseSseText(text: string): unknown[] {
  const messages: unknown[] = []
  for (const event of text.split('\n\n')) {
    const dataLine = event.split('\n').find((l) => l.startsWith('data: '))
    if (dataLine) {
      try {
        messages.push(JSON.parse(dataLine.slice(6)))
      } catch {
        /* ignore */
      }
    }
  }
  return messages
}

async function callTool(name: string, args: Record<string, unknown>) {
  const { transport } = await createSession(notebookId, ['admin'])
  async function rpc(method: string, params?: unknown, id?: number, sessionId?: string) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    if (sessionId) headers['Mcp-Session-Id'] = sessionId
    const res = await transport.handleRequest(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: id ?? null }),
      }),
    )
    return {
      sessionId: res.headers.get('Mcp-Session-Id') || sessionId || '',
      body: parseSseText(await res.text()),
    }
  }
  const init = await rpc(
    'initialize',
    { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    1,
  )
  await rpc('notifications/initialized', undefined, undefined, init.sessionId)
  const call = await rpc('tools/call', { name, arguments: args }, 2, init.sessionId)
  await transport.close()
  const msg = call.body[0] as Record<string, unknown>
  const result = msg.result as { isError?: boolean; content: Array<{ text: string }> }
  const payload = result?.content?.[0]?.text ? (JSON.parse(result.content[0].text) as Record<string, unknown>) : null
  return { result, payload }
}

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-mcp-vault-'))
  vaultDir = mkdtempSync(join('/tmp', 'notefast-mcp-vault-root-'))
  notebookId = initDb(testDir).notebookId
  _setRuntimeForTests(null)
})

afterAll(async () => {
  if (runtime) await runtime.stop().catch(() => undefined)
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
  rmSync(vaultDir, { recursive: true, force: true })
})

describe('MCP vault 工具', () => {
  test('未启用 vault → status.enabled=false；rebuild 报错而不是崩溃', async () => {
    const status = await callTool('notefast_vault_status', {})
    expect(status.payload).toMatchObject({ enabled: false })

    const rebuild = await callTool('notefast_vault_rebuild', {})
    expect(rebuild.result.isError).toBe(true)
    expect((rebuild.payload as { error: { code: string } }).error.code).toBe('invalid_params')
  })

  test('未启用 vault 时传 path 创建文档 → invalid_params', async () => {
    const res = await callTool('notefast_create_doc', {
      title: '不应落盘',
      markdown: 'x',
      path: 'inbox',
    })
    expect(res.result.isError).toBe(true)
    expect((res.payload as { error: { code: string } }).error.code).toBe('invalid_params')
  })

  test('启用后：status 有根目录与文件数，rebuild 返回统计', async () => {
    writeFileSync(join(vaultDir, 'a.md'), 'alpha\n')
    runtime = createVaultRuntime({ db: getDb(), notebookId, config: makeConfig(vaultDir) })
    await runtime.start({ awaitReconcile: true })

    const status = await callTool('notefast_vault_status', {})
    expect(status.payload).toMatchObject({ enabled: true, root: vaultDir, files: 1 })
    expect((status.payload as { conflicts: { count: number } }).conflicts.count).toBe(0)

    writeFileSync(join(vaultDir, 'b.md'), 'beta\n')
    const rebuild = await callTool('notefast_vault_rebuild', {})
    expect(rebuild.payload).toMatchObject({ totalFiles: 2, created: 1 })
  })

  test('create_doc 的 path 落进 properties.vault_hint_path；越界路径被拒', async () => {
    const ok = await callTool('notefast_create_doc', {
      title: 'MCP 落盘',
      markdown: '正文',
      path: 'inbox/notes/',
    })
    const docId = (ok.payload as { doc_id: string }).doc_id
    const row = getBlockById(getDb(), docId)!
    expect(JSON.parse(row.properties).vault_hint_path).toBe('inbox/notes')

    const bad = await callTool('notefast_create_doc', {
      title: '越界',
      markdown: 'x',
      path: '../escape',
    })
    expect(bad.result.isError).toBe(true)
    expect((bad.payload as { error: { code: string } }).error.code).toBe('invalid_params')
  })

  test('get_doc 带出 vault_path（vault 文档）', async () => {
    const path = 'notes/来源.md'
    mkdirSync(join(vaultDir, 'notes'), { recursive: true })
    writeFileSync(join(vaultDir, path), '来自文件\n')
    await runtime.ingest(path)
    const docId = getVaultFileByPath(getDb(), notebookId, path)!.doc_id

    const res = await callTool('notefast_get_doc', { doc_id: docId })
    expect(res.payload).toMatchObject({ vault_path: path })
    expect((res.payload as { doc: { content: string } }).doc.content).toBe('来源')
  })

  test('vault 图片引用保持相对路径原样（V-303 由 Web 侧解析）', async () => {
    const path = 'notes/图.md'
    mkdirSync(join(vaultDir, 'notes'), { recursive: true })
    writeFileSync(join(vaultDir, path), '![图](assets/x.png)\n\n![[y.png]]\n')
    await runtime.ingest(path)
    const docId = getVaultFileByPath(getDb(), notebookId, path)!.doc_id

    const res = await callTool('notefast_get_doc', { doc_id: docId })
    const doc = (res.payload as { doc: { children: Array<{ content: string }> } }).doc
    expect(doc.children[0]!.content).toBe('![图](assets/x.png)')
    expect(doc.children[1]!.content).toBe('![[y.png]]')
  })
})
