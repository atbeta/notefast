/**
 * 词法检索（FTS5 + LIKE 双路）单元测试
 *
 * 覆盖：
 * - 无空格中文整串查询（unicode61 整 token 短语不命中 → LIKE 子串命中）
 * - 2 字中文词（trigram 死区 → LIKE 无死区）
 * - 中文 + ASCII 混合查询
 * - AND 零结果 → OR 降级 / strictOnly 不降级
 * - 标题通道（titleOnly 只查文档根块）
 * - ASCII 行为不回归（FTS 命中保持、子串命中）
 * - LIKE 通配符注入（% / _ 按字面匹配）
 * - hybridSearch 集成（中文 fts_hits > 0、标题词进 top5）
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb, getDb } from '../db'
import { createPluginSystem } from '@notefast/core'
import {
  initAiRuntime,
  _setRuntimeForTests,
} from '../services/aiRuntime'
import { lexicalSearch } from '../lexicalSearch'
import { hybridSearch } from '../ai/hybridSearch'

let testDir: string
let pluginSystem: ReturnType<typeof createPluginSystem>
let nb: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-lexical-'))
  initDb(testDir)
  pluginSystem = createPluginSystem()
  initAiRuntime(pluginSystem, testDir)
})

afterAll(() => {
  // 不泄漏 AI runtime 给其他测试文件（bun 跨文件共享模块状态）
  _setRuntimeForTests(null)
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  // 保证无 embedding/chat provider：hybridSearch 走纯词法通道
  _setRuntimeForTests(null)
  initAiRuntime(pluginSystem, testDir)
  getDb().query('DELETE FROM blocks').run()
  getDb().exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")
  nb = crypto.randomUUID()
  getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
})

/** 种一篇文档（根块 + 一个正文块），返回正文块 id 与文档 id */
function seedBlock(opts: { content: string; title?: string; blockId?: string }) {
  const db = getDb()
  const id = opts.blockId ?? crypto.randomUUID()
  const now = new Date().toISOString()
  const docId = crypto.randomUUID()
  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'document', ?, 0, 0, ?, ?)`,
  ).run(docId, nb, docId, opts.title ?? 'Untitled', now, now)
  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'paragraph', ?, 0, 1, ?, ?)`,
  ).run(id, nb, docId, docId, opts.content, now, now)
  return { id, docId }
}

describe('lexicalSearch — 中文召回（LIKE 路）', () => {
  test('无空格中文整串命中包含该字串的正文（审查原例）', () => {
    const { id } = seedBlock({ content: '聊聊向量数据库怎么选的问题' })
    seedBlock({ content: '完全无关的内容' })

    const hits = lexicalSearch('向量数据库怎么选', { limit: 10 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h) => h.id === id)).toBe(true)
    expect(hits[0]!.matched_by).toBe('like_and')
    // rank_score 是列表内相对分：0 < score <= 1 且单调不增
    for (let i = 0; i < hits.length; i++) {
      expect(hits[i]!.rank_score).toBeGreaterThan(0)
      expect(hits[i]!.rank_score).toBeLessThanOrEqual(1)
      if (i > 0) expect(hits[i]!.rank_score).toBeLessThanOrEqual(hits[i - 1]!.rank_score)
    }
  })

  test('2 字中文词命中（trigram 死区对 LIKE 不存在）', () => {
    const { id } = seedBlock({ content: '笔记软件选型记录' })
    const hits = lexicalSearch('笔记', { limit: 10 })
    expect(hits.some((h) => h.id === id)).toBe(true)
  })

  test('问句前缀剥离：「什么是XXX」命中正文为「XXX是什么」的块', () => {
    // 用户场景：问「什么是KMP算法」文档写「KMP算法是什么」——整句子串匹配不到
    const { id } = seedBlock({ content: 'KMP算法是什么？一种字符串匹配算法' })
    seedBlock({ content: '完全无关的内容' })

    const hits = lexicalSearch('什么是KMP算法', { limit: 10 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h) => h.id === id)).toBe(true)
    expect(hits[0]!.matched_by).toBe('like_and')
  })

  test('循环剥离：「如何选择向量数据库」命中含「向量数据库」的正文', () => {
    const { id } = seedBlock({ content: '向量数据库怎么选？看召回质量' })
    const hits = lexicalSearch('如何选择向量数据库', { limit: 10 })
    expect(hits.some((h) => h.id === id)).toBe(true)
    expect(hits[0]!.matched_by).toBe('like_and')
  })

  test('剥离后核心词过短则保留原 term（不误伤短词）', () => {
    // 「什么是A」剥离后剩「A」1 字符 < 2 → 保留原 term「什么是A」
    const { id } = seedBlock({ content: '什么是A？A 是答案' })
    const hits = lexicalSearch('什么是A', { limit: 10 })
    expect(hits.some((h) => h.id === id)).toBe(true)
  })

  test('中文与 ASCII 混合查询：两个 term 都要命中', () => {
    const both = seedBlock({ content: '用 sqlite 做向量检索的笔记' })
    seedBlock({ content: '只谈向量数据库，不提具体引擎' })

    const hits = lexicalSearch('sqlite 向量', { limit: 10 })
    expect(hits.some((h) => h.id === both.id)).toBe(true)
    // 只含一个 term 的块不进严格 AND 结果
    expect(hits.every((h) => h.content.includes('sqlite') && h.content.includes('向量'))).toBe(true)
  })

  test('AND 零结果 → OR 降级；strictOnly 保持空', () => {
    seedBlock({ content: '苹果派做法' })
    seedBlock({ content: '香蕉种植笔记' })

    const strict = lexicalSearch('苹果 香蕉', { limit: 10, strictOnly: true })
    expect(strict.length).toBe(0)

    const relaxed = lexicalSearch('苹果 香蕉', { limit: 10 })
    expect(relaxed.length).toBe(2)
    expect(relaxed.every((h) => h.matched_by === 'like_or')).toBe(true)
  })

  test('标题通道：查询词只在文档标题时命中根块', () => {
    const { docId } = seedBlock({ title: '波西米亚狂想曲赏析', content: '今天天气不错' })

    const hits = lexicalSearch('波西米亚', { limit: 5, strictOnly: true, titleOnly: true })
    expect(hits.length).toBe(1)
    expect(hits[0]!.id).toBe(docId)
    expect(hits[0]!.type).toBe('document')
    expect(hits[0]!.matched_by).toBe('title')
  })
})

describe('lexicalSearch — ASCII 不回归', () => {
  test('原 FTS 能命中的 ASCII 查询仍命中', () => {
    const { id } = seedBlock({ content: 'Tauri window close handler pattern' })
    const hits = lexicalSearch('Tauri close', { limit: 10 })
    expect(hits.some((h) => h.id === id)).toBe(true)
  })

  test('ERR_CONNECTION_RESET 子串命中', () => {
    const { id } = seedBlock({ content: '连接失败 ERR_CONNECTION_RESET 自动重试' })
    const hits = lexicalSearch('ERR_CONNECTION_RESET', { limit: 10 })
    expect(hits.some((h) => h.id === id)).toBe(true)
  })
})

describe('lexicalSearch — LIKE 通配符注入', () => {
  test('查询含 100% 不报错且按字面匹配', () => {
    const { id } = seedBlock({ content: '本月目标完成度 100% 达标' })

    const hits = lexicalSearch('100%', { limit: 10 })
    expect(hits.some((h) => h.id === id)).toBe(true)

    // % 被转义为字面量：50% 不匹配 100%（若 % 生效为通配符则会误中）
    const none = lexicalSearch('50%', { limit: 10 })
    expect(none.length).toBe(0)
  })

  test('下划线按字面匹配（不当作单字符通配符）', () => {
    seedBlock({ content: '变量名 user_name 的命名规范' })
    seedBlock({ content: 'username 连写风格' })

    const hits = lexicalSearch('user_name', { limit: 10, strictOnly: true })
    expect(hits.length).toBe(1)
    expect(hits[0]!.content).toContain('user_name')
  })
})

describe('hybridSearch 集成', () => {
  test('中文查询 fts_hits > 0（原基线 ≈ 0）', async () => {
    const { id } = seedBlock({ content: '聊聊向量数据库怎么选的问题' })

    const report = await hybridSearch({ query: '向量数据库怎么选', topK: 5 })
    expect(report.retrieval.fts_hits).toBeGreaterThan(0)
    expect(report.retrieval.fts_matched_by?.like_and).toBeGreaterThan(0)
    expect(report.citations.some((c) => c.block_id === id)).toBe(true)
  })

  test('标题词查询：相关文档根块进 top5', async () => {
    const { docId } = seedBlock({ title: '马尔克斯书单', content: '今天天气不错' })
    seedBlock({ title: '无关文档', content: '另一段无关正文' })

    const report = await hybridSearch({ query: '马尔克斯', topK: 5 })
    expect(report.citations.some((c) => c.block_id === docId)).toBe(true)
  })
})
