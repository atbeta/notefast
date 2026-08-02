/**
 * 实体最小版测试（图谱数据层：entities + entity_mentions）
 *
 * 覆盖：
 * - normalize 边界与归并（大小写/标点变体并为一实体）
 * - store：upsert 幂等、mention_count 增减、归零删实体、软删级联
 * - 登记 E2E（mock fetch）：一次抽取两处消费（tool kind 不建链但登记实体）
 * - 更新重抽：afterUpdate 双清理（旧 mentions 清、新 mentions 建、孤儿实体清理）
 * - ai_exclude purge / 取消排除重抽、inbox 升格重抽
 * - 实体召回路（中文实体名查询召回内容不含查询词的块）与 hybridSearch 第四路
 * - 三个 REST 端点契约形状
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { initDb, closeDb, getDb } from '../db'
import { createPluginSystem } from '@notefast/core'
import {
  initAiRuntime,
  applyNewConfig,
  _setRuntimeForTests,
  getRuntime,
} from '../services/aiRuntime'
import { analyzeBlock, _resetRateLimitForTests } from '../ai/autoLink'
import { registerMentions } from '../ai/entities'
import { entitySearch } from '../ai/entitySearch'
import { hybridSearch } from '../ai/hybridSearch'
import { writeDocAiExclude, applyAiExcludeChange } from '../ai/aiExclude'
import { initVectorStore } from '../ai/indexer'
import { getBlockById } from '../store/blocks'
import {
  addMention,
  deleteMentionsFromSource,
  deleteMentionsTouchingBlocks,
  findEntityByName,
  getEntityById,
  listEntities,
  listEntitiesNeedingDescription,
  listEntityMentions,
  normalizeEntityName,
  updateEntityDescription,
  upsertEntity,
} from '../store/entities'
import { describeEntity, _resetDescribeRateLimitForTests } from '../ai/entityDescribe'
import docsRouter from '../api/docs'
import entitiesRouter, { docEntities } from '../api/entities'

let testDir: string
let pluginSystem: ReturnType<typeof createPluginSystem>
let app: Hono

function makeProvider(chatModel = 'gpt-4o-mini') {
  return {
    id: 'x',
    label: 'x',
    preset: 'custom',
    baseUrl: 'http://mock',
    apiKey: '',
    embeddingModel: '',
    chatModel,
    timeoutMs: 5000,
    extraHeaders: {},
  } as const
}

beforeAll(async () => {
  testDir = mkdtempSync(join('/tmp', 'notefast-entities-'))
  initDb(testDir)
  await initVectorStore()
  pluginSystem = createPluginSystem()
  app = new Hono()
  app.use('*', cors({ origin: '*' }))
  app.route('/api/v1/docs', docsRouter)
  app.route('/api/v1/docs', docEntities)
  app.route('/api/v1/entities', entitiesRouter)
})

afterAll(() => {
  _setRuntimeForTests(null)
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  _setRuntimeForTests(null)
  initAiRuntime(pluginSystem, testDir)
  _resetRateLimitForTests()
  _resetDescribeRateLimitForTests()
  const db = getDb()
  db.query('DELETE FROM entity_mentions').run()
  db.query('DELETE FROM entities').run()
  db.query('DELETE FROM block_refs').run()
  db.query('DELETE FROM blocks').run()
  db.exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")
})

function seedDocWithBlocks(opts: {
  docTitle: string
  blocks: Array<{ id?: string; content: string; type?: string }>
  status?: string
  aiExclude?: boolean
}): string {
  const db = getDb()
  const nb = crypto.randomUUID()
  db.query('INSERT OR IGNORE INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
  const docId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, status, ai_exclude, sort, level, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'document', ?, ?, ?, 0, 0, ?, ?)`,
  ).run(docId, nb, docId, opts.docTitle, opts.status ?? 'note', opts.aiExclude ? 1 : 0, now, now)
  let level = 1
  for (const b of opts.blocks) {
    const bid = b.id ?? crypto.randomUUID()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(bid, nb, docId, docId, b.type ?? 'paragraph', b.content, level, now, now)
    level++
  }
  return docId
}

function chatResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** chat-only mock（实体登记不需要 embedding）；fetcher 可自定义多次调用行为 */
function mockChat(fetcher?: (callCount: number) => string) {
  _setRuntimeForTests(null)
  initAiRuntime(pluginSystem, testDir)
  applyNewConfig(
    {
      version: 1,
      chat: { ...makeProvider(), apiKey: 'key', baseUrl: 'http://mock', embeddingModel: '' } as never,
      embedding: null,
      autoIndex: false,
      reranker: null,
      autoLink: {
        enabled: true,
        notebookScope: 'all',
        maxPerBlock: 5,
        minConfidence: 0.85,
        minMargin: 0.15,
        excludeAnchorKinds: ['tool'],
        excludeSelfDoc: true,
        rateLimitPerMinute: 1000,
      },
    },
    pluginSystem,
  )
  let calls = 0
  getRuntime().setFetchImpl((async () => {
    calls++
    return chatResponse(fetcher ? fetcher(calls) : JSON.stringify({ mentions: [] }))
  }) as unknown as typeof fetch)
}

/** fire-and-forget 路径（升格 / 取消排除）轮询等待 */
async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

async function api(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const res = await app.fetch(new Request(`http://localhost${path}`, init))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

// ───────────────────── normalize / 归并 ─────────────────────

describe('normalizeEntityName', () => {
  test('trim → lowercase → 去首尾标点 → 压缩内部空白', () => {
    expect(normalizeEntityName('  KMP  ')).toBe('kmp')
    expect(normalizeEntityName('「向量数据库」')).toBe('向量数据库')
    expect(normalizeEntityName('Rust!')).toBe('rust')
    expect(normalizeEntityName('...NoteFast...')).toBe('notefast')
    expect(normalizeEntityName('hello   world')).toBe('hello world')
    expect(normalizeEntityName('向量  数据库')).toBe('向量 数据库')
  })

  test('纯标点 → 空串；全角不转换（宁多实体勿错并）', () => {
    expect(normalizeEntityName('！！！')).toBe('')
    expect(normalizeEntityName('ＫＭＰ')).toBe('ｋｍｐ') // 仅 lowercase，不做全角→半角
  })
})

describe('实体归并（规范化名精确匹配）', () => {
  test('大小写 / 首尾标点变体并为一实体，display 保留首个写法', () => {
    const db = getDb()
    seedDocWithBlocks({ docTitle: 'T', blocks: [{ id: 'mb1', content: 'KMP 是高效的字符串匹配' }] })
    const n = registerMentions('mb1', [
      { anchor: 'KMP', kind: 'concept' },
      { anchor: '「kmp」', kind: 'concept' },
      { anchor: 'kmp ', kind: 'concept' },
    ])
    expect(n).toBe(1)
    const rows = listEntities(db)
    expect(rows.length).toBe(1)
    expect(rows[0]!.name).toBe('kmp')
    expect(rows[0]!.display).toBe('KMP') // 首个 surface 写法
    expect(rows[0]!.mention_count).toBe(1) // 同 (entity, block) 幂等
    expect(findEntityByName(db, 'kmp')!.id).toBe(rows[0]!.id)
  })

  test('registerMentions 过滤过短 / 纯标点 anchor', () => {
    seedDocWithBlocks({ docTitle: 'T', blocks: [{ id: 'mb2', content: '随便记一点东西凑长度' }] })
    const n = registerMentions('mb2', [
      { anchor: '！', kind: 'concept' },
      { anchor: 'a', kind: 'concept' },
      { anchor: '向量数据库', kind: 'concept' },
    ])
    expect(n).toBe(1)
    expect(listEntities(getDb()).map((e) => e.name)).toEqual(['向量数据库'])
  })
})

// ───────────────────── store：count 维护 / 级联 ─────────────────────

describe('store/entities 计数与级联', () => {
  test('addMention 幂等 + deleteMentionsFromSource 归零删实体', () => {
    const db = getDb()
    seedDocWithBlocks({
      docTitle: 'T',
      blocks: [
        { id: 'cb1', content: '块一内容足够长' },
        { id: 'cb2', content: '块二内容足够长' },
      ],
    })
    const e = upsertEntity(db, { name: 'kmp', display: 'KMP', kind: 'concept' })
    expect(addMention(db, e.id, 'cb1', 'KMP')).toBe(true)
    expect(addMention(db, e.id, 'cb1', 'KMP')).toBe(false) // 幂等
    expect(addMention(db, e.id, 'cb2', 'kmp')).toBe(true)
    expect(getEntityById(db, e.id)!.mention_count).toBe(2)

    const affected = deleteMentionsFromSource(db, 'cb1')
    expect(affected).toEqual([e.id])
    expect(getEntityById(db, e.id)!.mention_count).toBe(1)

    deleteMentionsFromSource(db, 'cb2')
    expect(getEntityById(db, e.id)).toBeNull() // 归零删实体
  })

  test('deleteMentionsTouchingBlocks 软删级联', () => {
    const db = getDb()
    seedDocWithBlocks({
      docTitle: 'T',
      blocks: [
        { id: 'db1', content: '块一内容足够长' },
        { id: 'db2', content: '块二内容足够长' },
      ],
    })
    registerMentions('db1', [{ anchor: 'KMP', kind: 'concept' }])
    registerMentions('db2', [{ anchor: 'KMP', kind: 'concept' }])
    expect(getEntityById(db, findEntityByName(db, 'kmp')!.id)!.mention_count).toBe(2)

    deleteMentionsTouchingBlocks(db, ['db1', 'db2'])
    expect(findEntityByName(db, 'kmp')).toBeNull()
    expect(listEntityMentions(db, 'whatever').length).toBe(0)
  })
})

// ───────────────────── 登记 E2E（mock fetch）─────────────────────

describe('一次抽取两处消费（E2E）', () => {
  test('tool kind 不建链但登记实体；result.entities 计数', async () => {
    mockChat(() =>
      JSON.stringify({
        mentions: [
          { anchor: 'notefast_create_doc', kind: 'tool' },
          { anchor: 'KMP', kind: 'concept' },
        ],
      }),
    )
    seedDocWithBlocks({
      docTitle: '源',
      blocks: [{ id: 'e2e-src', content: '调用 notefast_create_doc 创建，比如 KMP 笔记' }],
    })
    const r = await analyzeBlock({
      blockId: 'e2e-src',
      content: '调用 notefast_create_doc 创建，比如 KMP 笔记',
      notebookScope: 'all',
      maxPerBlock: 5,
    })
    expect(r.entities).toBe(2)
    const names = listEntities(getDb()).map((e) => e.name)
    expect(names).toContain('notefast_create_doc')
    expect(names).toContain('kmp')
    const tool = findEntityByName(getDb(), 'notefast_create_doc')!
    expect(tool.kind).toBe('tool')
    // 无候选可链，但实体必须落库
    expect(r.applied).toBe(0)
  })

  test('文档根（标题）entitiesOnly：只登记实体不建链', async () => {
    mockChat(() => JSON.stringify({ mentions: [{ anchor: '向量数据库', kind: 'concept' }] }))
    const docId = seedDocWithBlocks({
      docTitle: '向量数据库',
      blocks: [{ id: 'doc-c1', content: '随便记一点关于选型的内容' }],
    })
    const docBlock = getBlockById(getDb(), docId)!
    await pluginSystem.note.afterCreate.call(docBlock as never)

    expect(findEntityByName(getDb(), '向量数据库')).not.toBeNull()
    const mentions = listEntityMentions(getDb(), findEntityByName(getDb(), '向量数据库')!.id)
    expect(mentions.map((m) => m.block_id)).toEqual([docId])
    expect((getDb().query('SELECT count(*) AS c FROM block_refs').get() as { c: number }).c).toBe(0)
  })

  test('afterUpdate 双清理：旧 mentions 清、新 mentions 建、孤儿实体删除', async () => {
    mockChat((calls) =>
      calls === 1
        ? JSON.stringify({ mentions: [{ anchor: 'KMP', kind: 'concept' }] })
        : JSON.stringify({ mentions: [{ anchor: 'BM25', kind: 'concept' }] }),
    )
    seedDocWithBlocks({
      docTitle: 'T',
      blocks: [{ id: 'up-b1', content: 'KMP 是高效的字符串匹配' }],
    })

    await pluginSystem.note.afterCreate.call(getBlockById(getDb(), 'up-b1') as never)
    expect(findEntityByName(getDb(), 'kmp')).not.toBeNull()

    getDb().query('UPDATE blocks SET content = ? WHERE id = ?').run('BM25 是经典的排序算法', 'up-b1')
    await pluginSystem.note.afterUpdate.call(getBlockById(getDb(), 'up-b1') as never)

    expect(findEntityByName(getDb(), 'kmp')).toBeNull() // 孤儿实体清理
    const bm = findEntityByName(getDb(), 'bm25')
    expect(bm).not.toBeNull()
    expect(listEntityMentions(getDb(), bm!.id).map((m) => m.block_id)).toEqual(['up-b1'])
  })
})

// ───────────────────── 生命周期（D4）─────────────────────

describe('生命周期：ai_exclude 与升格', () => {
  test('ai_exclude 开启 purge mentions；取消后全 doc 重抽补齐', async () => {
    mockChat(() => JSON.stringify({ mentions: [{ anchor: '向量数据库', kind: 'concept' }] }))
    const docId = seedDocWithBlocks({
      docTitle: 'T',
      blocks: [{ id: 'ax-b1', content: '向量数据库选型笔记记录' }],
    })
    await pluginSystem.note.afterCreate.call(getBlockById(getDb(), 'ax-b1') as never)
    expect(findEntityByName(getDb(), '向量数据库')).not.toBeNull()

    // 开启排除：物理清理实体提及（不同于 ai_auto refs 的自然收敛）
    writeDocAiExclude(docId, true)
    const purge = await applyAiExcludeChange(docId, false, true)
    expect(purge?.mentions).toBe(1)
    expect(findEntityByName(getDb(), '向量数据库')).toBeNull()

    // 取消排除：reanalyzeDoc 重抽（fire-and-forget，轮询等待）
    writeDocAiExclude(docId, false)
    await applyAiExcludeChange(docId, true, false)
    const ok = await waitFor(() => findEntityByName(getDb(), '向量数据库') !== null)
    expect(ok).toBe(true)
  })

  test('inbox 不抽取；升格 note 后全 doc 重抽补齐实体', async () => {
    mockChat(() => JSON.stringify({ mentions: [{ anchor: '向量数据库', kind: 'concept' }] }))
    const docId = seedDocWithBlocks({
      docTitle: 'T',
      status: 'inbox',
      blocks: [{ id: 'ib-b1', content: '向量数据库选型笔记记录' }],
    })
    // inbox：hook 不抽取
    await pluginSystem.note.afterCreate.call(getBlockById(getDb(), 'ib-b1') as never)
    expect(findEntityByName(getDb(), '向量数据库')).toBeNull()

    // 升格 → PATCH 触发 reanalyzeDoc（fire-and-forget）
    const { status, body } = await api('PATCH', `/api/v1/docs/${docId}/status`, { status: 'note' })
    expect(status).toBe(200)
    expect(body.status).toBe('note')
    const ok = await waitFor(() => findEntityByName(getDb(), '向量数据库') !== null)
    expect(ok).toBe(true)
  })
})

// ───────────────────── 实体召回路（D3）─────────────────────

describe('实体召回路', () => {
  test('中文实体名查询：召回内容不含查询词的提及块', () => {
    const db = getDb()
    seedDocWithBlocks({
      docTitle: 'T',
      blocks: [
        { id: 'es-b1', content: '记录一下选型心得，改天再展开' },
        { id: 'es-b2', content: '完全不相关的购物清单记录' },
      ],
    })
    const e = upsertEntity(db, { name: '向量数据库', display: '向量数据库', kind: 'concept' })
    addMention(db, e.id, 'es-b1', '向量数据库')

    // 整句包含实体名（CJK 无空格查询的召回主力）
    const hits = entitySearch('向量数据库怎么选')
    expect(hits.length).toBe(1)
    expect(hits[0]!.block_id).toBe('es-b1')
    expect(hits[0]!.doc_title).toBe('T')

    // 精确匹配同样命中
    expect(entitySearch('向量数据库')[0]!.block_id).toBe('es-b1')

    // 无命中短路
    expect(entitySearch('毫无关系的查询')).toEqual([])
  })

  test('hybridSearch 第四路：实体命中块进 citations', async () => {
    const db = getDb()
    seedDocWithBlocks({
      docTitle: 'T',
      blocks: [{ id: 'hs-b1', content: '记录一下选型心得，改天再展开' }],
    })
    const e = upsertEntity(db, { name: '向量数据库', display: '向量数据库', kind: 'concept' })
    addMention(db, e.id, 'hs-b1', '向量数据库')

    // 块内容不含查询词，纯靠实体通道召回
    const report = await hybridSearch({ query: '向量数据库怎么选', topK: 5 })
    expect(report.citations.map((c) => c.block_id)).toContain('hs-b1')
  })

  test('实体表为空时零成本短路', async () => {
    expect(entitySearch('任意查询')).toEqual([])
    const report = await hybridSearch({ query: '任意查询', topK: 5 })
    expect(report.citations).toEqual([])
  })
})

// ───────────────────── REST 契约 ─────────────────────

describe('实体 REST API', () => {
  function seedEntities() {
    const docId = seedDocWithBlocks({
      docTitle: '选型笔记',
      blocks: [
        { id: 'api-b1', content: '向量数据库选型笔记记录，Qdrant 与 sqlite-vec 对比' },
        { id: 'api-b2', content: '又一段提到向量数据库的内容' },
      ],
    })
    registerMentions('api-b1', [
      { anchor: '向量数据库', kind: 'concept' },
      { anchor: 'Qdrant', kind: 'tool' },
    ])
    registerMentions('api-b2', [{ anchor: '向量数据库', kind: 'concept' }])
    return docId
  }

  test('GET /entities：mention_count 倒序 + q 过滤', async () => {
    seedEntities()
    const { status, body } = await api('GET', '/api/v1/entities')
    expect(status).toBe(200)
    const list = body.entities as Array<Record<string, unknown>>
    expect(list.length).toBe(2)
    expect(list[0]).toMatchObject({ name: '向量数据库', display: '向量数据库', kind: 'concept', mention_count: 2 })
    expect(list[1]).toMatchObject({ name: 'qdrant', kind: 'tool', mention_count: 1 })
    console.log('GET /api/v1/entities →', JSON.stringify(body))

    const filtered = await api('GET', '/api/v1/entities?q=qdr')
    const fl = filtered.body.entities as Array<Record<string, unknown>>
    expect(fl.length).toBe(1)
    expect(fl[0]!.name).toBe('qdrant')
  })

  test('GET /entities/:id：详情 + mentions（block_snippet ≤ 120，含 doc_status）；不存在 404', async () => {
    seedEntities()
    const entityId = findEntityByName(getDb(), '向量数据库')!.id
    const { status, body } = await api('GET', `/api/v1/entities/${entityId}`)
    expect(status).toBe(200)
    const entity = body.entity as Record<string, unknown>
    expect(entity).toMatchObject({ id: entityId, name: '向量数据库', display: '向量数据库', kind: 'concept', mention_count: 2 })
    const mentions = body.mentions as Array<Record<string, unknown>>
    expect(mentions.length).toBe(2)
    expect(mentions[0]).toMatchObject({ doc_title: '选型笔记', doc_status: 'note', surface: '向量数据库' })
    expect(typeof mentions[0]!.block_id).toBe('string')
    expect(typeof mentions[0]!.doc_id).toBe('string')
    expect((mentions[0]!.block_snippet as string).length).toBeLessThanOrEqual(120)
    console.log('GET /api/v1/entities/:id →', JSON.stringify(body))

    const missing = await api('GET', '/api/v1/entities/ghost')
    expect(missing.status).toBe(404)
  })

  test('GET /docs/:id/entities：本篇实体去重（按 mention_count 倒序）；文档不存在 404', async () => {
    const docId = seedEntities()
    const { status, body } = await api('GET', `/api/v1/docs/${docId}/entities`)
    expect(status).toBe(200)
    const list = body.entities as Array<Record<string, unknown>>
    expect(list.length).toBe(2)
    expect(list[0]).toMatchObject({ display: '向量数据库', kind: 'concept', mention_count: 2, surface: '向量数据库' })
    expect(list[1]).toMatchObject({ display: 'Qdrant', kind: 'tool', mention_count: 1 })
    console.log('GET /api/v1/docs/:id/entities →', JSON.stringify(body))

    const missing = await api('GET', '/api/v1/docs/ghost/entities')
    expect(missing.status).toBe(404)
  })
})

// ───────────────────── 实体描述（E2）─────────────────────

describe('实体描述（E2）', () => {
  test('listEntitiesNeedingDescription 只挑 mention_count≥3 且无描述；update 后不再入选', () => {
    const db = getDb()
    seedDocWithBlocks({
      docTitle: 'T',
      blocks: [
        { id: 'desc-b1', content: '首次提及概念一的块' },
        { id: 'desc-b2', content: '再次提及概念一的块' },
        { id: 'desc-b3', content: '第三次提及概念一的块' },
      ],
    })
    registerMentions('desc-b1', [{ anchor: '概念一', kind: 'concept' }])
    registerMentions('desc-b2', [{ anchor: '概念一', kind: 'concept' }])
    registerMentions('desc-b3', [{ anchor: '概念一', kind: 'concept' }])
    const e = findEntityByName(db, '概念一')!
    expect(e.mention_count).toBe(3)
    expect(listEntitiesNeedingDescription(db, 10).map((x) => x.id)).toContain(e.id)

    updateEntityDescription(db, e.id, '一个概念')
    expect(getEntityById(db, e.id)!.description).toBe('一个概念')
    expect(listEntitiesNeedingDescription(db, 10).map((x) => x.id)).not.toContain(e.id)
  })

  test('describeEntity：低于阈值不生成；达标后 mock chat 生成并落库', async () => {
    mockChat(() => '「概念一」是一个用于描述测试的示例概念')
    seedDocWithBlocks({
      docTitle: 'T',
      blocks: [
        { id: 'de-b1', content: '这里提到概念一，用于描述生成的上下文' },
        { id: 'de-b2', content: '再次提到概念一，补充描述依据' },
      ],
    })
    registerMentions('de-b1', [{ anchor: '概念一', kind: 'concept' }])
    registerMentions('de-b2', [{ anchor: '概念一', kind: 'concept' }])
    const e2 = findEntityByName(getDb(), '概念一')!
    expect(e2.mention_count).toBe(2)
    expect(await describeEntity(e2.id)).toBe(false)
    expect(getEntityById(getDb(), e2.id)!.description).toBeNull()

    seedDocWithBlocks({ docTitle: 'T2', blocks: [{ id: 'de-b3', content: '第三次提到概念一，达标生成描述' }] })
    registerMentions('de-b3', [{ anchor: '概念一', kind: 'concept' }])
    const e3 = findEntityByName(getDb(), '概念一')!
    expect(e3.mention_count).toBe(3)
    expect(await describeEntity(e3.id)).toBe(true)
    expect(getEntityById(getDb(), e3.id)!.description).toContain('概念一')
  })

  test('POST /entities/:id/describe：手动重新生成描述', async () => {
    mockChat(() => '「概念一」重生成后的新描述')
    seedDocWithBlocks({
      docTitle: 'T',
      blocks: [
        { id: 'de-2a', content: '首次提到概念一的内容' },
        { id: 'de-2b', content: '再次提到概念一的内容' },
        { id: 'de-2c', content: '第三次提到概念一的内容' },
      ],
    })
    registerMentions('de-2a', [{ anchor: '概念一', kind: 'concept' }])
    registerMentions('de-2b', [{ anchor: '概念一', kind: 'concept' }])
    registerMentions('de-2c', [{ anchor: '概念一', kind: 'concept' }])
    const e = findEntityByName(getDb(), '概念一')!
    const { status, body } = await api('POST', `/api/v1/entities/${e.id}/describe`)
    expect(status).toBe(200)
    expect((body as { regenerated: boolean }).regenerated).toBe(true)
    expect((body as { description: string | null }).description).toContain('重生成')

    const missing = await api('POST', '/api/v1/entities/ghost/describe')
    expect(missing.status).toBe(404)
  })
})
