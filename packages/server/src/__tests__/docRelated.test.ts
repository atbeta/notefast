/**
 * 文档语义邻居：query 构造 + GET /docs/:id/related
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { initDb, closeDb, getDb } from '../db'
import docs from '../api/docs'
import { initVectorStore } from '../ai/indexer'
import { VECTOR_INDEX_VERSION } from '../ai/vectorStore'
import { buildRelatedQuery, listRelatedDocs } from '../services/docRelated'
import { writeTags, type BlockRow } from '@notefast/core'

let testDir: string
let app: Hono
let notebookId: string

beforeAll(async () => {
  testDir = mkdtempSync(join('/tmp', 'notefast-doc-related-'))
  const result = initDb(testDir)
  notebookId = result.notebookId
  await initVectorStore()
  app = new Hono()
  app.route('/api/v1/docs', docs)
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  getDb().query('DELETE FROM blocks').run()
  getDb().query('DELETE FROM block_vectors').run()
  getDb().query(
    `UPDATE vector_store_state
     SET status = 'stale', model_fingerprint = NULL, dimension = NULL,
         indexed_count = 0, error = NULL
     WHERE id = 'default'`,
  ).run()
  getDb().exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")
})

function seedRootVector(blockId: string, vec: number[], fingerprint = 'related-test-fp') {
  const db = getDb()
  db.query(
    `INSERT INTO block_vectors
       (block_id, embedding, dim, embedding_model, content_hash, index_version, updated_at)
     VALUES (?, ?, ?, ?, 'x', ?, datetime('now'))`,
  ).run(blockId, JSON.stringify(vec), vec.length, fingerprint, VECTOR_INDEX_VERSION)
  db.query(
    `UPDATE vector_store_state
     SET status = 'ready', model_fingerprint = ?, dimension = ?,
         indexed_count = (SELECT count(*) FROM block_vectors), error = NULL
     WHERE id = 'default'`,
  ).run(fingerprint, vec.length)
}

async function createDoc(title: string, markdown: string, tags?: string[]): Promise<string> {
  const res = await app.fetch(new Request('http://localhost/api/v1/docs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notebook_id: notebookId, title, markdown, tags }),
  }))
  expect(res.status).toBe(201)
  const body = await res.json() as { id: string }
  return body.id
}

describe('buildRelatedQuery', () => {
  test('标题 + tags', () => {
    const row = {
      id: 'x',
      content: '向量数据库选型',
      tags: writeTags(['rag', 'sqlite']),
    } as BlockRow
    expect(buildRelatedQuery(row)).toBe('向量数据库选型 rag sqlite')
  })

  test('无标题时用正文截断', () => {
    const row = { id: 'x', content: '', tags: '[]' } as BlockRow
    const q = buildRelatedQuery(row, '这是一段关于检索增强生成的正文内容')
    expect(q).toContain('检索增强生成')
  })
})

describe('listRelatedDocs / GET related', () => {
  test('同主题两篇 → 互相出现且不含自身', async () => {
    // 共享独特词元，保证无 embedding 时词法路也能互命中
    const probe = 'NoteFastRelatedProbeXYZ'
    const a = await createDoc(
      `${probe} 向量检索入门`,
      `本文围绕 ${probe} 介绍本地向量检索与 RAG。\n\n嵌入模型与索引重建。`,
      ['rag'],
    )
    const b = await createDoc(
      `${probe} 实践笔记`,
      `继续讨论 ${probe}：混合召回与 FTS 配合。\n\n个人知识库场景。`,
      ['rag'],
    )

    const relatedA = await listRelatedDocs(a, { limit: 8 })
    expect(relatedA).not.toBeNull()
    expect(relatedA!.items.every((it) => it.doc_id !== a)).toBe(true)
    expect(relatedA!.items.map((it) => it.doc_id)).toContain(b)

    const res = await app.fetch(new Request(`http://localhost/api/v1/docs/${b}/related?limit=5`))
    expect(res.status).toBe(200)
    const body = await res.json() as { items: Array<{ doc_id: string }> }
    expect(body.items.every((it) => it.doc_id !== b)).toBe(true)
    expect(body.items.some((it) => it.doc_id === a)).toBe(true)
  })

  test('标题无共享词时仍可按已存向量距离互命中', async () => {
    const a = await createDoc('AlphaOnlyTopic', '这篇只谈甲方案的实现细节。')
    const b = await createDoc('BetaOnlySubject', '另一篇完全不同措辞的乙记录。')
    const c = await createDoc('GammaUnrelated', '正交主题的第三篇。')
    seedRootVector(a, [1, 0, 0])
    seedRootVector(b, [0.98, 0.1, 0])
    seedRootVector(c, [0, 0, 1])

    const relatedA = await listRelatedDocs(a, { limit: 8 })
    expect(relatedA).not.toBeNull()
    expect(relatedA!.items.map((it) => it.doc_id)).toContain(b)
    expect(relatedA!.items[0]?.doc_id).toBe(b)
    expect(relatedA!.items.every((it) => it.doc_id !== a)).toBe(true)
  })

  test('指定正文块时按该块向量找邻居，而不是文档根', async () => {
    const hub = await createDoc('HubDoc', '甲主题段落。\n\n乙主题段落。')
    const nearA = await createDoc('NearAlpha', '与甲接近的邻居。')
    const nearB = await createDoc('NearBeta', '与乙接近的邻居。')
    const bodies = (
      getDb().query(
        `SELECT id FROM blocks WHERE root_id = ? AND id != ? AND is_deleted = 0 ORDER BY sort, id`,
      ).all(hub, hub) as Array<{ id: string }>
    ).map((r) => r.id)
    expect(bodies.length).toBeGreaterThanOrEqual(2)
    seedRootVector(bodies[0]!, [1, 0, 0])
    seedRootVector(bodies[1]!, [0, 1, 0])
    seedRootVector(nearA, [0.97, 0.05, 0])
    seedRootVector(nearB, [0.05, 0.97, 0])

    const fromA = await listRelatedDocs(hub, { limit: 8, blockId: bodies[0] })
    expect(fromA!.items[0]?.doc_id).toBe(nearA)

    const res = await app.fetch(
      new Request(`http://localhost/api/v1/docs/${hub}/related?limit=8&blockId=${bodies[1]}`),
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { items: Array<{ doc_id: string }> }
    expect(body.items[0]?.doc_id).toBe(nearB)
  })

  test('文档不存在 → 404', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/docs/no-such/related'))
    expect(res.status).toBe(404)
  })
})
