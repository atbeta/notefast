/**
 * 文档语义邻居：query 构造 + GET /docs/:id/related
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { initDb, closeDb, getDb } from '../db'
import docs from '../api/docs'
import { buildRelatedQuery, listRelatedDocs } from '../services/docRelated'
import { writeTags, type BlockRow } from '@notefast/core'

let testDir: string
let app: Hono
let notebookId: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-doc-related-'))
  const result = initDb(testDir)
  notebookId = result.notebookId
  app = new Hono()
  app.route('/api/v1/docs', docs)
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  getDb().query('DELETE FROM blocks').run()
  getDb().exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")
})

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

  test('文档不存在 → 404', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/docs/no-such/related'))
    expect(res.status).toBe(404)
  })
})
