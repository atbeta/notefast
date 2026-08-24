import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { initDb, closeDb, getDb } from '../db'
import { createSession } from '../mcp/server'
import { _setRuntimeForTests } from '../services/aiRuntime'

let testDir: string
let notebookId: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-mcp-blockops-'))
  notebookId = initDb(testDir).notebookId
  // 隔离：共享进程里其他测试文件可能残留 mock AI runtime
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

async function callTool(name: string, args: Record<string, unknown>) {
  const { transport } = await createSession(notebookId, ['admin'])
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
  const call = await rpc('tools/call', { name, arguments: args }, 2, init.sessionId)
  await transport.close()
  const msg = call.body[0] as Record<string, unknown>
  const result = msg.result as { isError?: boolean; content: Array<{ text: string }> }
  const payload = result?.content?.[0]?.text ? JSON.parse(result.content[0].text) as Record<string, unknown> : null
  return { result, payload }
}

/** 直接插一行 block（doc 根 / 子块通用） */
function insertRow(opts: {
  id: string
  parentId?: string | null
  rootId: string
  type?: string
  content: string
  sort?: number
  level?: number
}): void {
  const now = new Date().toISOString()
  getDb().query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, status, sort, level, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'note', ?, ?, ?, ?)`,
  ).run(
    opts.id,
    notebookId,
    opts.parentId ?? null,
    opts.rootId,
    opts.type ?? 'paragraph',
    opts.content,
    opts.sort ?? 0,
    opts.level ?? 0,
    now,
    now,
  )
}

/** 一篇文档根 + 两个顶层段落（para1 带一个子块） */
function setupDoc(title = 'block ops 测试') {
  const docId = crypto.randomUUID()
  const para1 = crypto.randomUUID()
  const para1Child = crypto.randomUUID()
  const para2 = crypto.randomUUID()
  insertRow({ id: docId, rootId: docId, type: 'document', content: title, level: 0 })
  insertRow({ id: para1, parentId: docId, rootId: docId, content: '段落一', sort: 0, level: 1 })
  insertRow({ id: para1Child, parentId: para1, rootId: docId, content: '段落一的子块', sort: 0, level: 2 })
  insertRow({ id: para2, parentId: docId, rootId: docId, content: '段落二', sort: 1, level: 1 })
  return { docId, para1, para1Child, para2 }
}

/** ai_exclude 文档（经 REST 端点写入，避免手拼 properties JSON） */
async function setupExcludedDoc() {
  const { docId, para1 } = setupDoc('secret-block-ops')
  const { default: docs } = await import('../api/docs')
  const app = new Hono()
  app.route('/api/v1/docs', docs)
  await app.request(`http://localhost/api/v1/docs/${docId}/ai-exclude`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ai_exclude: true }),
  })
  return { docId, childId: para1 }
}

function errCode(payload: Record<string, unknown> | null): string {
  return (payload!.error as { code: string }).code
}

describe('notefast_delete_block', () => {
  test('删除子块及其子树；restore 可恢复', async () => {
    const { para1, para1Child } = setupDoc()
    const del = await callTool('notefast_delete_block', { block_id: para1 })
    expect(del.result.isError).toBeFalsy()
    expect(del.payload!.deleted).toBe(true)
    expect(del.payload!.count).toBe(2) // para1 + 子块

    const rows = getDb().query('SELECT id, is_deleted FROM blocks WHERE id IN (?, ?)').all(para1, para1Child) as Array<{ id: string; is_deleted: number }>
    expect(rows.every((r) => r.is_deleted === 1)).toBe(true)

    const restored = await callTool('notefast_restore_block', { block_id: para1 })
    expect(restored.result.isError).toBeFalsy()
  })

  test('文档根块 → invalid_params，指路 notefast_delete_doc', async () => {
    const { docId } = setupDoc()
    const r = await callTool('notefast_delete_block', { block_id: docId })
    expect(r.result.isError).toBe(true)
    expect(errCode(r.payload)).toBe('invalid_params')
    expect((r.payload!.error as { message: string }).message).toContain('notefast_delete_doc')
    // 未误删
    const row = getDb().query('SELECT is_deleted FROM blocks WHERE id = ?').get(docId) as { is_deleted: number }
    expect(row.is_deleted).toBe(0)
  })

  test('ghost → not_found；ai_exclude 子块 → forbidden', async () => {
    const ghost = await callTool('notefast_delete_block', { block_id: 'ghost' })
    expect(ghost.result.isError).toBe(true)
    expect(errCode(ghost.payload)).toBe('not_found')

    const { childId } = await setupExcludedDoc()
    const denied = await callTool('notefast_delete_block', { block_id: childId })
    expect(denied.result.isError).toBe(true)
    expect(errCode(denied.payload)).toBe('forbidden')
  })
})

describe('notefast_move_block', () => {
  test('换父：para2 移到 para1 下，level/root 跟随', async () => {
    const { docId, para1, para2 } = setupDoc()
    const r = await callTool('notefast_move_block', { block_id: para2, new_parent_id: para1 })
    expect(r.result.isError).toBeFalsy()
    const block = (r.payload!.block as { id: string; parent_id: string; root_id: string; level: number })
    expect(block.parent_id).toBe(para1)
    expect(block.root_id).toBe(docId)
    expect(block.level).toBe(2)
  })

  test('跨文档移动：root_id 切换到目标文档', async () => {
    const a = setupDoc('文档 A')
    const b = setupDoc('文档 B')
    const r = await callTool('notefast_move_block', { block_id: a.para2, new_parent_id: b.docId })
    expect(r.result.isError).toBeFalsy()
    const block = (r.payload!.block as { parent_id: string; root_id: string; level: number })
    expect(block.parent_id).toBe(b.docId)
    expect(block.root_id).toBe(b.docId)
    expect(block.level).toBe(1)
  })

  test('目标父块 ghost → not_found；目标父块属 ai_exclude 文档 → forbidden', async () => {
    const { para2 } = setupDoc()
    const ghost = await callTool('notefast_move_block', { block_id: para2, new_parent_id: 'ghost-parent' })
    expect(ghost.result.isError).toBe(true)
    expect(errCode(ghost.payload)).toBe('not_found')

    const excluded = await setupExcludedDoc()
    const normal = setupDoc('正常文档')
    const denied = await callTool('notefast_move_block', { block_id: normal.para2, new_parent_id: excluded.childId })
    expect(denied.result.isError).toBe(true)
    expect(errCode(denied.payload)).toBe('forbidden')

    // 自身属 ai_exclude 文档同样拒绝
    const deniedSelf = await callTool('notefast_move_block', { block_id: excluded.childId, new_parent_id: normal.docId })
    expect(deniedSelf.result.isError).toBe(true)
    expect(errCode(deniedSelf.payload)).toBe('forbidden')
  })
})

describe('notefast_list_revisions', () => {
  test('update_block 后可列出修订（新→旧）；limit 生效', async () => {
    const { insertDocFromMarkdown } = await import('../services/docImport')
    const created = insertDocFromMarkdown(getDb(), { notebookId, title: '修订测试', markdown: '原始内容' })
    const blockId = created.blockIds[0]!
    await callTool('notefast_update_block', { block_id: blockId, content: '第二版' })
    await callTool('notefast_update_block', { block_id: blockId, content: '第三版' })

    const r = await callTool('notefast_list_revisions', { block_id: blockId })
    expect(r.result.isError).toBeFalsy()
    const revisions = r.payload!.revisions as Array<{ rev: number; content: string; actor: string }>
    expect(revisions.length).toBe(2)
    expect(revisions[0]!.content).toBe('第二版') // 最新修订在前
    expect(revisions[1]!.content).toBe('原始内容')
    expect(revisions[0]!.actor).toBe('mcp')

    const limited = await callTool('notefast_list_revisions', { block_id: blockId, limit: 1 })
    expect((limited.payload!.revisions as unknown[]).length).toBe(1)
  })

  test('ghost → not_found；ai_exclude → forbidden', async () => {
    const ghost = await callTool('notefast_list_revisions', { block_id: 'ghost' })
    expect(ghost.result.isError).toBe(true)
    expect(errCode(ghost.payload)).toBe('not_found')

    const { childId } = await setupExcludedDoc()
    const denied = await callTool('notefast_list_revisions', { block_id: childId })
    expect(denied.result.isError).toBe(true)
    expect(errCode(denied.payload)).toBe('forbidden')
  })
})

describe('notefast_create_ref / notefast_delete_ref', () => {
  test('建链 → created；同对重复 → already_exists 幂等；by-pair 解链 → deleted；再删 → not_found', async () => {
    const a = setupDoc('ref 源')
    const b = setupDoc('ref 目标')

    const created = await callTool('notefast_create_ref', { source_id: a.para1, target_id: b.para1 })
    expect(created.result.isError).toBeFalsy()
    expect(created.payload!.created).toBe(true)
    expect(created.payload!.ref_type).toBe('link')

    // 幂等：同对重复建链不报错、不重复插入
    const dup = await callTool('notefast_create_ref', { source_id: a.para1, target_id: b.para1 })
    expect(dup.result.isError).toBeFalsy()
    expect(dup.payload!.already_exists).toBe(true)
    const count = getDb().query('SELECT COUNT(*) AS c FROM block_refs WHERE source_id = ? AND target_id = ?')
      .get(a.para1, b.para1) as { c: number }
    expect(count.c).toBe(1)

    const del = await callTool('notefast_delete_ref', { source_id: a.para1, target_id: b.para1 })
    expect(del.result.isError).toBeFalsy()
    expect(del.payload!.deleted).toBe(true)
    expect(del.payload!.count).toBe(1)

    const again = await callTool('notefast_delete_ref', { source_id: a.para1, target_id: b.para1 })
    expect(again.result.isError).toBe(true)
    expect(errCode(again.payload)).toBe('not_found')
  })

  test('自引用 → invalid_params；ghost 源/目标 → not_found；ai_exclude → forbidden', async () => {
    const a = setupDoc('ref 守卫')

    const self = await callTool('notefast_create_ref', { source_id: a.para1, target_id: a.para1 })
    expect(self.result.isError).toBe(true)
    expect(errCode(self.payload)).toBe('invalid_params')

    const ghostSource = await callTool('notefast_create_ref', { source_id: 'ghost', target_id: a.para1 })
    expect(errCode(ghostSource.payload)).toBe('not_found')
    const ghostTarget = await callTool('notefast_create_ref', { source_id: a.para1, target_id: 'ghost' })
    expect(errCode(ghostTarget.payload)).toBe('not_found')

    const excluded = await setupExcludedDoc()
    const deniedCreate = await callTool('notefast_create_ref', { source_id: excluded.childId, target_id: a.para1 })
    expect(errCode(deniedCreate.payload)).toBe('forbidden')
    const deniedDelete = await callTool('notefast_delete_ref', { source_id: a.para1, target_id: excluded.childId })
    expect(errCode(deniedDelete.payload)).toBe('forbidden')
  })
})
