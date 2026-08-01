import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb, getDb } from '../db'
import {
  insertBlock,
  updateBlock,
  nowTimestamp,
  listBlockRevisions,
  getBlockRevision,
  listDocRevisions,
  recordDocSnapshot,
  MAX_REVISIONS_PER_BLOCK,
} from '../store/blocks'
import blocksRouter from '../api/blocks'
import docsRouter from '../api/docs'
import { Hono } from 'hono'

/**
 * Block 内容历史（block_revisions）：
 * - updateBlock 变更 content 时把「旧值」写入 revision（新值不入库）
 * - 无变化（同 content）不写 revision
 * - actor 标注来源（user/ai/mcp/revert）
 * - 超过 MAX_REVISIONS_PER_BLOCK 裁剪最旧
 * - API：GET /blocks/:id/revisions、POST /blocks/:id/revisions/:rev/restore、
 *   GET /docs/:id/revisions（文档级跨块时间线）
 */

let testDir: string
let notebookId: string
let app: Hono

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-revisions-test-'))
  const result = initDb(testDir)
  notebookId = result.notebookId
  app = new Hono()
  app.route('/blocks', blocksRouter)
  app.route('/docs', docsRouter)
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

function insertDocRoot(id: string, title: string): void {
  insertBlock(getDb(), {
    id,
    notebook_id: notebookId,
    parent_id: null,
    root_id: id,
    type: 'document',
    content: title,
    sort: 0,
    level: 0,
    now: nowTimestamp(),
  })
}

function insertParagraph(id: string, rootId: string, content: string): void {
  insertBlock(getDb(), {
    id,
    notebook_id: notebookId,
    parent_id: rootId,
    root_id: rootId,
    type: 'paragraph',
    content,
    sort: 0,
    level: 1,
    now: nowTimestamp(),
  })
}

describe('block revisions (store)', () => {
  test('updateBlock 变更 content 时记录旧值；actor 可标注', () => {
    const db = getDb()
    const id = crypto.randomUUID()
    insertParagraph(id, id, 'v1')

    updateBlock(db, id, { content: 'v2' })
    updateBlock(db, id, { content: 'v3', actor: 'ai' })

    const revs = listBlockRevisions(db, id)
    // 记录的是旧值：第一次改 v1→v2 存 v1，第二次改 v2→v3 存 v2；新→旧排序
    expect(revs.length).toBe(2)
    expect(revs[0]!.content).toBe('v2') // 最新一条 = 上一次的旧值
    expect(revs[0]!.actor).toBe('ai')
    expect(revs[1]!.content).toBe('v1')
    expect(revs[1]!.actor).toBe('user')
  })

  test('content 无变化（同值）不写 revision', () => {
    const db = getDb()
    const id = crypto.randomUUID()
    insertParagraph(id, id, 'v1')
    updateBlock(db, id, { content: 'v1' }) // 无变化
    expect(listBlockRevisions(db, id).length).toBe(0)
  })

  test('非 content 字段变更不写 revision', () => {
    const db = getDb()
    const id = crypto.randomUUID()
    insertParagraph(id, id, 'v1')
    updateBlock(db, id, { status: 'archived' })
    expect(listBlockRevisions(db, id).length).toBe(0)
  })

  test('超过上限裁剪最旧 revision', () => {
    const db = getDb()
    const id = crypto.randomUUID()
    insertParagraph(id, id, 'seed')
    for (let i = 1; i <= MAX_REVISIONS_PER_BLOCK + 10; i++) {
      updateBlock(db, id, { content: `v${i}` })
    }
    const revs = listBlockRevisions(db, id)
    expect(revs.length).toBeLessThanOrEqual(MAX_REVISIONS_PER_BLOCK)
    // 保留的是最近 N 条
    expect(revs[0]!.content).toBe(`v${MAX_REVISIONS_PER_BLOCK + 10 - 1}`)
  })

  test('getBlockRevision 按 block+rev 取单条；不存在返回 null', () => {
    const db = getDb()
    const id = crypto.randomUUID()
    insertParagraph(id, id, 'v1')
    updateBlock(db, id, { content: 'v2' })
    const rev = getBlockRevision(db, id, 1)
    expect(rev?.content).toBe('v1')
    expect(getBlockRevision(db, id, 99)).toBeNull()
  })

  test('listDocRevisions 聚合整篇文档（含标题块与子块）跨块时间线', () => {
    const db = getDb()
    const docId = crypto.randomUUID()
    insertDocRoot(docId, '标题')
    const p1 = crypto.randomUUID()
    const p2 = crypto.randomUUID()
    insertParagraph(p1, docId, '段落一')
    insertParagraph(p2, docId, '段落二')

    // 标题、两个段落各改一次
    updateBlock(db, docId, { content: '新标题' })
    updateBlock(db, p1, { content: '段落一改' })
    updateBlock(db, p2, { content: '段落二改' })

    const revs = listDocRevisions(db, docId)
    // 3 次变更 → 3 条 revision（跨块，全部 kind='block'）
    expect(revs.length).toBe(3)
    expect(revs.every((r) => r.kind === 'block')).toBe(true)
    // 各块旧值都在
    const byBlock = new Map(revs.map((r) => [r.block_id, r.content]))
    expect(byBlock.get(docId)).toBe('标题')
    expect(byBlock.get(p1)).toBe('段落一')
    expect(byBlock.get(p2)).toBe('段落二')
  })

  test('recordDocSnapshot 写入 doc_snapshots（独立表，kind=snapshot），参与文档级历史', () => {
    const db = getDb()
    const docId = crypto.randomUUID()
    insertDocRoot(docId, '标题')
    const p = crypto.randomUUID()
    insertParagraph(p, docId, '段落')

    // 编辑器整篇保存：旧整篇合并快照
    recordDocSnapshot(db, docId, '# 标题\n\n段落')

    const revs = listDocRevisions(db, docId)
    expect(revs.length).toBe(1)
    expect(revs[0]!.kind).toBe('snapshot')
    expect(revs[0]!.actor).toBe('editor')
    expect(revs[0]!.content).toBe('# 标题\n\n段落')

    // 再次保存 → 两条快照，新→旧
    recordDocSnapshot(db, docId, '# 新标题\n\n段落已改')
    const revs2 = listDocRevisions(db, docId)
    expect(revs2.length).toBe(2)
    expect(revs2[0]!.content).toBe('# 新标题\n\n段落已改')
    expect(revs2[1]!.content).toBe('# 标题\n\n段落')
  })

  test('整篇快照与块级修订共存于文档历史，kind 区分来源', () => {
    const db = getDb()
    const docId = crypto.randomUUID()
    insertDocRoot(docId, '标题')
    const p = crypto.randomUUID()
    insertParagraph(p, docId, '段落')

    // 块级编辑（MCP/chat/单块 PATCH）：子块产生 revision
    updateBlock(db, p, { content: '段落改' })
    // 整篇保存：产生快照
    recordDocSnapshot(db, docId, '# 标题\n\n段落改')

    const revs = listDocRevisions(db, docId)
    expect(revs.length).toBe(2)
    // kind 区分：快照 + 块级
    expect(revs.some((r) => r.kind === 'snapshot' && r.actor === 'editor')).toBe(true)
    expect(revs.some((r) => r.kind === 'block' && r.block_id === p && r.actor === 'user')).toBe(true)
  })
})

describe('revisions API', () => {
  test('GET /blocks/:id/revisions 返回历史（新→旧）', async () => {
    const db = getDb()
    const id = crypto.randomUUID()
    insertParagraph(id, id, 'v1')
    updateBlock(db, id, { content: 'v2' })

    const res = await app.request(`/blocks/${id}/revisions`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { block_id: string; revisions: Array<{ content: string }> }
    expect(body.block_id).toBe(id)
    expect(body.revisions[0]!.content).toBe('v1')
  })

  test('GET /blocks/:id/revisions 对不存在 block 返回 404', async () => {
    const res = await app.request(`/blocks/${crypto.randomUUID()}/revisions`)
    expect(res.status).toBe(404)
  })

  test('POST /blocks/:id/revisions/:rev/restore 回退内容并记为一次新修订', async () => {
    const db = getDb()
    const id = crypto.randomUUID()
    insertParagraph(id, id, 'v1')
    updateBlock(db, id, { content: 'v2' })
    updateBlock(db, id, { content: 'v3' })
    expect(getBlockByIdContent(id)).toBe('v3')

    // 回退到 rev 1（内容 v1）
    const res = await app.request(`/blocks/${id}/revisions/1/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(200)
    expect(getBlockByIdContent(id)).toBe('v1')

    // 回退本身也是一次编辑：v3→v1 的旧值 v3 被记录为新 revision
    const revs = listBlockRevisions(db, id)
    expect(revs[0]!.content).toBe('v3')
    expect(revs[0]!.actor).toBe('revert')
  })

  test('POST restore 对不存在的 rev 返回 404；非法 rev 返回 400', async () => {
    const id = crypto.randomUUID()
    insertParagraph(id, id, 'v1')
    const notFound = await app.request(`/blocks/${id}/revisions/99/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(notFound.status).toBe(404)
    const badRev = await app.request(`/blocks/${id}/revisions/abc/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(badRev.status).toBe(400)
  })

  test('GET /docs/:id/revisions 返回文档级历史；不存在文档 404', async () => {
    const db = getDb()
    const docId = crypto.randomUUID()
    insertDocRoot(docId, '标题')
    const p = crypto.randomUUID()
    insertParagraph(p, docId, '段落')
    updateBlock(db, docId, { content: '新标题' })
    updateBlock(db, p, { content: '段落改' })

    const res = await app.request(`/docs/${docId}/revisions`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { doc_id: string; revisions: Array<{ block_id: string }> }
    expect(body.doc_id).toBe(docId)
    expect(body.revisions.length).toBe(2)

    const missing = await app.request(`/docs/${crypto.randomUUID()}/revisions`)
    expect(missing.status).toBe(404)
  })

  test('PUT /docs/:id/markdown 保存后产生一条整篇快照 revision（标题不重复记录）', async () => {
    const db = getDb()
    const docId = crypto.randomUUID()
    insertDocRoot(docId, '旧标题')
    const p = crypto.randomUUID()
    insertParagraph(p, docId, '旧段落')

    // 编辑器保存路径：整篇替换 + 标题也变了
    const res = await app.request(`/docs/${docId}/markdown`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: '# 新标题\n\n新段落', title: '新标题' }),
    })
    expect(res.status).toBe(200)

    // 只应产生一条「editor」整篇快照，标题不被 updateBlock 单独再记一条
    const revs = listDocRevisions(db, docId)
    const snapshots = revs.filter((r) => r.actor === 'editor')
    expect(snapshots.length).toBe(1)
    expect(snapshots[0]!.content).toContain('旧标题')
    expect(snapshots[0]!.content).toContain('旧段落')
    // 无标题块的 user/回退 等额外记录
    expect(revs.filter((r) => r.actor !== 'editor').length).toBe(0)
  })

  test('POST /docs/:id/snapshots/:rev/restore 回退整篇快照（actor=revert，且回退本身留一条新快照）', async () => {
    const db = getDb()
    const docId = crypto.randomUUID()
    insertDocRoot(docId, '标题')
    const p = crypto.randomUUID()
    insertParagraph(p, docId, '段落')

    // 第一次整篇替换：快照 rev1 = 初始状态（标题+段落），文档变为 标题+v2
    await app.request(`/docs/${docId}/markdown`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: '# 标题\n\nv2', title: '标题' }),
    })
    // 第二次 → 快照 rev2 = "# 标题\n\nv2"，文档变为 标题+v3
    await app.request(`/docs/${docId}/markdown`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: '# 标题\n\nv3', title: '标题' }),
    })
    // 回退到 rev2（v2 内容）
    const res = await app.request(`/docs/${docId}/snapshots/2/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(200)

    // 正文恢复为 v2（快照 rev2 的内容）
    const doc = await app.request(`/docs/${docId}`)
    const docBody = (await doc.json()) as { content: string; children: Array<{ content: string }> }
    expect(docBody.content).toBe('标题')
    expect(docBody.children.some((c) => c.content === 'v2')).toBe(true)

    // 回退本身也产生一条 revert 快照（回退前的 v3 状态）
    const revs = listDocRevisions(db, docId)
    const revertSnapshot = revs.find((r) => r.kind === 'snapshot' && r.actor === 'revert')
    expect(revertSnapshot).toBeDefined()
    expect(revertSnapshot!.content).toContain('v3')

    // 不存在的快照 → 404
    const missing = await app.request(`/docs/${docId}/snapshots/99/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(missing.status).toBe(404)
  })
})

function getBlockByIdContent(id: string): string {
  const row = getDb().query('SELECT content FROM blocks WHERE id = ?').get(id) as
    | { content: string }
    | undefined
  return row?.content ?? ''
}
