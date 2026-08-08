/**
 * 查询理解：zod 解析 / 归一化纯函数 + fail-closed 接入 hybridSearch
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createPluginSystem, AiRuntime, emptyConfig } from '@notefast/core'
import { initDb, closeDb, getDb } from '../db'
import {
  initAiRuntime,
  _setRuntimeForTests,
} from '../services/aiRuntime'
import {
  parseUnderstandingJson,
  normalizeTermGroups,
  understandQuery,
} from '../ai/queryUnderstanding'
import { lexicalSearch } from '../lexicalSearch'
import { hybridSearch } from '../ai/hybridSearch'
import { initTermDict, resetTermDictForTests } from '../termDict'

describe('parseUnderstandingJson / normalizeTermGroups', () => {
  test('合法 JSON 通过 zod', () => {
    const parsed = parseUnderstandingJson('{"terms":[["向量数据库","向量库"],["选型"]],"rewritten":"向量数据库 选型"}')
    expect(parsed).not.toBeNull()
    expect(parsed!.terms).toHaveLength(2)
    expect(parsed!.rewritten).toBe('向量数据库 选型')
  })

  test('markdown 围栏与 think 块可剥', () => {
    const raw = `<think>thinking</think>\n\`\`\`json\n{"terms":[["SQLite"]],"rewritten":"SQLite"}\n\`\`\``
    const parsed = parseUnderstandingJson(raw)
    expect(parsed?.terms[0]).toEqual(['SQLite'])
  })

  test('非法 / 空 terms 失败', () => {
    expect(parseUnderstandingJson('not json')).toBeNull()
    expect(parseUnderstandingJson('{"terms":[]}')).toBeNull()
    expect(parseUnderstandingJson('{"terms":[[]]}')).toBeNull()
  })

  test('normalize 去重、全半角、截断过短', () => {
    const groups = normalizeTermGroups([
      ['向量数据库', '向量数据库', 'Ａ'],
      [' 选型 ', '选型'],
      ['x'],
    ])
    expect(groups).toEqual([
      { variants: ['向量数据库'] },
      { variants: ['选型'] },
    ])
  })
})

function mockChatRuntime(reply: string): AiRuntime {
  const runtime = new AiRuntime(emptyConfig())
  ;(runtime as unknown as { chatProvider: { chat: () => Promise<string> } }).chatProvider = {
    chat: async () => reply,
  }
  return runtime
}

describe('understandQuery fail-closed + lexical termGroups', () => {
  let testDir: string
  let pluginSystem: ReturnType<typeof createPluginSystem>
  let nb: string

  beforeAll(() => {
    testDir = mkdtempSync(join('/tmp', 'notefast-qu-'))
    initDb(testDir)
    initTermDict(testDir)
    pluginSystem = createPluginSystem()
    initAiRuntime(pluginSystem, testDir)
  })

  afterAll(() => {
    _setRuntimeForTests(null)
    resetTermDictForTests()
    closeDb()
    rmSync(testDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    _setRuntimeForTests(null)
    initAiRuntime(pluginSystem, testDir)
    getDb().query('DELETE FROM blocks').run()
    getDb().exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")
    nb = crypto.randomUUID()
    getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
  })

  function seed(content: string, title = 'Doc') {
    const db = getDb()
    const now = new Date().toISOString()
    const docId = crypto.randomUUID()
    const id = crypto.randomUUID()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'document', ?, 0, 0, ?, ?)`,
    ).run(docId, nb, docId, title, now, now)
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'paragraph', ?, 0, 1, ?, ?)`,
    ).run(id, nb, docId, docId, content, now, now)
    return { id, docId }
  }

  test('无 chat → skipped', async () => {
    const u = await understandQuery('怎么选向量数据库')
    expect(u.status).toBe('skipped')
    expect(u.termGroups).toBeUndefined()
    expect(u.semanticQuery).toBe('怎么选向量数据库')
  })

  test('LLM 坏 JSON → failed，hybridSearch 降级仍可召回', async () => {
    const { id } = seed('聊聊向量数据库怎么选的问题', '向量数据库选型对比')
    _setRuntimeForTests(mockChatRuntime('NOT_JSON{{{'))

    const u = await understandQuery('怎么选向量数据库')
    expect(u.status).toBe('failed')

    // 用后缀问句验证降级后默认词法仍工作
    const report = await hybridSearch({
      query: '向量数据库怎么选',
      understandQuery: true,
      topK: 5,
    })
    expect(report.retrieval.query_understanding).toBe('failed')
    expect(report.retrieval.fts_hits).toBeGreaterThan(0)
    expect(report.citations.some((c) => c.block_id === id)).toBe(true)
  })

  test('termGroups 钩子：中置问句用外部组可命中', () => {
    const { id } = seed('本文讨论向量数据库选型要点', '向量库')
    const hits = lexicalSearch('怎么选向量数据库', {
      limit: 10,
      termGroups: [{ variants: ['向量数据库', '向量库'] }],
      sentence: '怎么选向量数据库',
    })
    expect(hits.some((h) => h.id === id)).toBe(true)
  })

  test('applied：理解结果驱动词法', async () => {
    const { id } = seed('本文讨论向量数据库选型要点', '选型')
    _setRuntimeForTests(mockChatRuntime(JSON.stringify({
      terms: [['向量数据库', '向量库'], ['选型']],
      rewritten: '向量数据库 选型',
    })))

    const u = await understandQuery('怎么选向量数据库')
    expect(u.status).toBe('applied')
    expect(u.termGroups?.length).toBe(2)

    const report = await hybridSearch({
      query: '怎么选向量数据库',
      understandQuery: true,
      topK: 5,
    })
    expect(report.retrieval.query_understanding).toBe('applied')
    expect(report.citations.some((c) => c.block_id === id)).toBe(true)
  })
})
