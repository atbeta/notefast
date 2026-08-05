/**
 * 图谱查询测试（实体共现图：store/graph + api/graph）
 *
 * 覆盖：
 * - 总览模式：top-N 按 mention_count、min_mention / kind 过滤、truncated 标志
 * - 中心实体：锚点不受 min_mention 约束、共现邻居 BFS 扩展（depth）
 * - 中心文档：锚点 = 文档提及实体
 * - 共现边：权重 = 共享文档数、边预算截断
 * - 生命周期语义：inbox/archived 文档的实体仍在图中（与 /entities 页一致）
 * - REST 契约：400 / 404 / 参数钳制
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { initDb, closeDb, getDb } from '../db'
import { registerMentions } from '../ai/entities'
import { normalizeEntityName, findEntityByName, deleteMentionsTouchingBlocks } from '../store/entities'
import {
  addAlias,
  addMention,
  findPotentialDuplicates,
  getEntityById,
  mergeEntities,
  resolveAlias,
  upsertEntity,
} from '../store/entities'
import { queryGraph, type GraphEdge } from '../store/graph'
import graphRouter from '../api/graph'

let testDir: string
let app: Hono

const A = '向量数据库'
const B = 'Qdrant'
const C = '张三'
const D = 'MindMap'
const kind = { A: 'concept', B: 'tool', C: 'person', D: 'concept' } as const

beforeAll(async () => {
  testDir = mkdtempSync(join('/tmp', 'notefast-graph-'))
  initDb(testDir)
  app = new Hono()
  app.use('*', cors({ origin: '*' }))
  app.route('/api/v1/graph', graphRouter)
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDb()
  db.query('DELETE FROM entity_mentions').run()
  db.query('DELETE FROM entities').run()
  db.query('DELETE FROM block_refs').run()
  db.query('DELETE FROM blocks').run()
  db.exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")
})

/** 建一篇文档并返回 docId；blocks 里的 id 用于后续挂提及 */
function seedDoc(opts: {
  docTitle: string
  blocks: Array<{ id?: string; content?: string }>
  status?: string
}): string {
  const db = getDb()
  const nb = crypto.randomUUID()
  db.query('INSERT OR IGNORE INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
  const docId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, status, ai_exclude, sort, level, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'document', ?, ?, ?, 0, 0, ?, ?)`,
  ).run(docId, nb, docId, opts.docTitle, opts.status ?? 'note', 0, now, now)
  let level = 1
  for (const b of opts.blocks) {
    const bid = b.id ?? crypto.randomUUID()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'paragraph', ?, 0, ?, ?, ?)`,
    ).run(bid, nb, docId, docId, b.content ?? '', level, now, now)
    level++
  }
  return docId
}

/** 三篇文档的共现图夹具：
 *  D1: {A, B, C}   D2: {A, B}   D3: {C, D}   → A/B 共现 2 篇，A/C、B/C、C/D 各共现 1 篇
 */
function seedCooccurrence() {
  const d1 = seedDoc({ docTitle: 'D1', blocks: [{ id: 'd1-a' }, { id: 'd1-b' }, { id: 'd1-c' }] })
  const d2 = seedDoc({ docTitle: 'D2', blocks: [{ id: 'd2-a' }, { id: 'd2-b' }] })
  const d3 = seedDoc({ docTitle: 'D3', blocks: [{ id: 'd3-c' }, { id: 'd3-d' }] })
  registerMentions('d1-a', [{ anchor: A, kind: kind.A }])
  registerMentions('d1-b', [{ anchor: B, kind: kind.B }])
  registerMentions('d1-c', [{ anchor: C, kind: kind.C }])
  registerMentions('d2-a', [{ anchor: A, kind: kind.A }])
  registerMentions('d2-b', [{ anchor: B, kind: kind.B }])
  registerMentions('d3-c', [{ anchor: C, kind: kind.C }])
  registerMentions('d3-d', [{ anchor: D, kind: kind.D }])
  return { d1, d2, d3 }
}

/** 按 anchor 查实体 id（内部先规范化） */
function entityId(name: string): string | undefined {
  const row = getDb()
    .query('SELECT id FROM entities WHERE name = ?')
    .get(normalizeEntityName(name)) as { id: string } | undefined
  return row?.id
}

function nodesByName(nodes: Array<{ name: string; distance: number; mention_count: number }>) {
  return Object.fromEntries(nodes.map((n) => [n.name, n]))
}

function edgeBetween(edges: GraphEdge[], a: string, b: string): GraphEdge | undefined {
  const idA = entityId(a)
  const idB = entityId(b)
  return edges.find(
    (e) => (e.source === idA && e.target === idB) || (e.source === idB && e.target === idA),
  )
}

describe('queryGraph 总览模式', () => {
  test('top-N 按 mention_count，min_mention 过滤', () => {
    seedCooccurrence()
    const { nodes, edges, truncated } = queryGraph(getDb(), { maxNodes: 10 })
    const byName = nodesByName(nodes)
    // A、B、C 各提及 2 次，D 提及 1 次
    expect(byName[norm(A)]!.mention_count).toBe(2)
    expect(byName[norm(D)]).toBeUndefined() // min_mention=2 默认过滤 D
    expect(truncated).toBe(false)
    // 边：A-B 权重 2；A-C、B-C 权重 1（C-D 中 D 被过滤所以不存在）
    expect(edgeBetween(edges, A, B)!.weight).toBe(2)
    expect(edgeBetween(edges, A, C)!.weight).toBe(1)
    expect(edgeBetween(edges, B, C)!.weight).toBe(1)
    expect(edgeBetween(edges, C, D)).toBeUndefined()
    expect(edges.length).toBe(3)
  })

  test('min_mention / kind 过滤生效', () => {
    seedCooccurrence()
    const all = queryGraph(getDb(), { maxNodes: 10, minMention: 1 })
    expect(new Set(all.nodes.map((n) => n.name))).toEqual(
      new Set([norm(A), norm(B), norm(C), norm(D)]),
    )
    const concept = queryGraph(getDb(), { maxNodes: 10, minMention: 1, kind: ['concept'] })
    expect(new Set(concept.nodes.map((n) => n.name))).toEqual(new Set([norm(A), norm(D)]))
    const mixed = queryGraph(getDb(), { maxNodes: 10, minMention: 1, kind: ['tool', 'person'] })
    expect(new Set(mixed.nodes.map((n) => n.name))).toEqual(new Set([norm(B), norm(C)]))
  })

  test('truncated：节点数达到预算', () => {
    seedCooccurrence()
    const { nodes, truncated } = queryGraph(getDb(), { maxNodes: 2, minMention: 1 })
    expect(nodes.length).toBe(2)
    expect(truncated).toBe(true)
  })

  test('空实体表返回空图', () => {
    const { nodes, edges, truncated } = queryGraph(getDb())
    expect(nodes).toEqual([])
    expect(edges).toEqual([])
    expect(truncated).toBe(false)
  })
})

function norm(name: string): string {
  return normalizeEntityName(name)
}

describe('queryGraph 中心模式', () => {
  test('中心实体：锚点不受 min_mention 约束；邻居共现', () => {
    seedCooccurrence()
    const idD = entityId(D)!
    const { nodes, edges, center } = queryGraph(getDb(), { center: { type: 'entity', id: idD } })
    expect(center).toMatchObject({ type: 'entity', id: idD })
    const byName = nodesByName(nodes)
    expect(byName[norm(D)]!.distance).toBe(0) // 锚点即使 mention_count=1 也包含
    expect(byName[norm(C)]!.distance).toBe(1) // D 只在 D3，与 C 共现
    // C 的邻居含 A/B（共享 D1）→ depth 2 时扩展到 A/B
    expect(byName[norm(A)]!.distance).toBe(2)
    expect(byName[norm(B)]!.distance).toBe(2)
    expect(edgeBetween(edges, C, D)!.weight).toBe(1)
  })

  test('depth=1 只取一跳邻居', () => {
    seedCooccurrence()
    const { nodes } = queryGraph(getDb(), { center: { type: 'entity', id: entityId(D)! }, depth: 1 })
    const byName = nodesByName(nodes)
    expect(Object.keys(byName).sort()).toEqual([norm(C), norm(D)].sort())
    expect(byName[norm(D)]!.distance).toBe(0)
    expect(byName[norm(C)]!.distance).toBe(1)
  })

  test('中心文档：锚点 = 该文档提及的全部实体', () => {
    const { d2 } = seedCooccurrence()
    const { nodes, edges, center } = queryGraph(getDb(), { center: { type: 'doc', id: d2 } })
    expect(center).toMatchObject({ type: 'doc', id: d2 })
    const byName = nodesByName(nodes)
    // D2 锚点 A/B（distance 0）+ 共现邻居 C
    expect(byName[norm(A)]!.distance).toBe(0)
    expect(byName[norm(B)]!.distance).toBe(0)
    expect(byName[norm(C)]!.distance).toBe(1)
    expect(edgeBetween(edges, A, B)!.weight).toBe(2)
  })

  test('边预算截断：只保留高权重边', () => {
    seedCooccurrence()
    const { edges } = queryGraph(getDb(), { maxNodes: 10, minMention: 1, maxEdges: 1 })
    expect(edges.length).toBe(1)
    expect(edges[0]!.weight).toBe(2) // A-B 权重最高
  })
})

describe('生命周期语义', () => {
  test('inbox / archived 文档的实体仍进图（人类视角，与 /entities 页一致）', () => {
    seedDoc({ docTitle: '收件', status: 'inbox', blocks: [{ id: 'ib-1' }, { id: 'ib-2' }] })
    seedDoc({ docTitle: '归档', status: 'archived', blocks: [{ id: 'ar-1' }, { id: 'ar-2' }] })
    registerMentions('ib-1', [{ anchor: '概念一', kind: 'concept' }])
    registerMentions('ib-2', [{ anchor: '工具一', kind: 'tool' }])
    registerMentions('ar-1', [{ anchor: '人物一', kind: 'person' }])
    registerMentions('ar-2', [{ anchor: '人物一', kind: 'person' }])
    const { nodes } = queryGraph(getDb(), { maxNodes: 10, minMention: 1 })
    expect(new Set(nodes.map((n) => n.name))).toEqual(new Set(['概念一', '工具一', '人物一']))
  })

  test('软删块的提及不计入共现（图只反映当前内容）', () => {
    const db = getDb()
    seedDoc({
      docTitle: 'D',
      blocks: [{ id: 'soft-b1', content: '' }, { id: 'soft-b2', content: '' }],
    })
    registerMentions('soft-b1', [{ anchor: '概念一', kind: 'concept' }])
    registerMentions('soft-b2', [{ anchor: '工具一', kind: 'tool' }])
    // 模拟整篇替换残留：旧块软删但提及还在 → 不得再产生共现边
    db.query('UPDATE blocks SET is_deleted = 1 WHERE id = ?').run('soft-b1')
    const { edges } = queryGraph(getDb(), { maxNodes: 10, minMention: 1 })
    const idA = entityId('概念一')
    const idB = entityId('工具一')
    const e = edges.find(
      (x) => (x.source === idA && x.target === idB) || (x.source === idB && x.target === idA),
    )
    expect(e).toBeUndefined()
  })

  test('真删除文档：mentions 被 store 级联清理后不再进图', () => {
    const db = getDb()
    seedDoc({ docTitle: 'D', blocks: [{ id: 'del-b1', content: '' }, { id: 'del-b2', content: '' }] })
    registerMentions('del-b1', [{ anchor: '概念一', kind: 'concept' }])
    registerMentions('del-b2', [{ anchor: '工具一', kind: 'tool' }])
    // 模拟删除路径的级联：deleteMentionsTouchingBlocks 清提及（含归零删实体）
    deleteMentionsTouchingBlocks(db, ['del-b1', 'del-b2'])
    const { nodes, edges } = queryGraph(getDb(), { maxNodes: 10, minMention: 1 })
    expect(nodes).toEqual([])
    expect(edges).toEqual([])
  })

  test('registerMentions 软删防护：对已软删块拒绝登记（竞态残留源头）', () => {
    const db = getDb()
    seedDoc({ docTitle: 'D', blocks: [{ id: 'race-b1', content: '' }] })
    db.query('UPDATE blocks SET is_deleted = 1 WHERE id = ?').run('race-b1')
    const n = registerMentions('race-b1', [{ anchor: '概念一', kind: 'concept' }])
    expect(n).toBe(0)
    expect(findEntityByName(db, '概念一')).toBeNull()
    const { nodes } = queryGraph(getDb(), { maxNodes: 10, minMention: 1 })
    expect(nodes).toEqual([])
  })
})

describe('queryGraph docs 模式（笔记关联图）', () => {
  function seedDocGraph() {
    seedDoc({ docTitle: 'D1', blocks: [{ id: 'g-d1-a' }, { id: 'g-d1-b' }] })
    seedDoc({ docTitle: 'D2', blocks: [{ id: 'g-d2-a' }] })
    seedDoc({ docTitle: 'D3', blocks: [{ id: 'g-d3-a' }] })
    seedDoc({ docTitle: 'D4 孤立', blocks: [{ id: 'g-d4-a' }] })
    registerMentions('g-d1-a', [{ anchor: A, kind: kind.A }])
    registerMentions('g-d1-b', [{ anchor: B, kind: kind.B }])
    registerMentions('g-d2-a', [{ anchor: A, kind: kind.A }, { anchor: C, kind: kind.C }])
    registerMentions('g-d3-a', [{ anchor: C, kind: kind.C }])
    // D1 → D2 一条 ai_auto 引用：D1-D2 权重 = 共享实体(A) + 引用 = 2
    getDb()
      .query('INSERT INTO block_refs (source_id, target_id, ref_type) VALUES (?, ?, ?)')
      .run('g-d1-a', 'g-d2-a', 'ai_auto')
  }

  function docId(title: string): string {
    return (
      getDb()
        .query('SELECT id FROM blocks WHERE type = ? AND is_deleted = 0 AND content = ?')
        .get('document', title) as { id: string }
    ).id
  }

  function edgeBetweenDocs(edges: GraphEdge[], a: string, b: string): GraphEdge | undefined {
    const idA = docId(a)
    const idB = docId(b)
    return edges.find(
      (e) => (e.source === idA && e.target === idB) || (e.source === idB && e.target === idA),
    )
  }

  test('总览：关联度倒序，孤立笔记兜底；min_mention 忽略', () => {
    seedDocGraph()
    const { nodes, edges, truncated } = queryGraph(getDb(), { mode: 'docs', maxNodes: 10, minMention: 999 })
    const byName = Object.fromEntries(nodes.map((n) => [n.display, n]))
    expect(nodes.length).toBe(4)
    expect(nodes[0]!.display).toBe('D2') // 关联度 2 最高
    expect(nodes[nodes.length - 1]!.display).toBe('D4 孤立') // 孤立笔记兜底在最后
    expect(nodes.every((n) => n.type === 'doc' && n.kind === 'doc')).toBe(true)
    // 大小代理 = 活块数
    expect(byName['D1']!.mention_count).toBe(2)
    expect(edgeBetweenDocs(edges, 'D1', 'D2')!.weight).toBe(2) // 共享实体 1 + 引用 1
    expect(edgeBetweenDocs(edges, 'D2', 'D3')!.weight).toBe(1) // 仅共享实体
    expect(truncated).toBe(false)
  })

  test('中心文档：BFS 经共享实体 / 引用扩展邻居', () => {
    seedDocGraph()
    const { nodes, edges, center } = queryGraph(getDb(), {
      mode: 'docs',
      center: { type: 'doc', id: docId('D1') },
    })
    expect(center).toMatchObject({ type: 'doc', id: docId('D1') })
    const byName = Object.fromEntries(nodes.map((n) => [n.display, n]))
    expect(byName['D1']!.distance).toBe(0)
    expect(byName['D2']!.distance).toBe(1)
    expect(byName['D3']!.distance).toBe(2) // 经 D2 一跳
    expect(byName['D4 孤立']).toBeUndefined()
    expect(edgeBetweenDocs(edges, 'D1', 'D2')!.weight).toBe(2)
  })

  test('docs 总览按最近活跃池裁剪（规模防护：度数自连接有上界）', () => {
    const db = getDb()
    const nb = 'pool-nb'
    db.query('INSERT OR IGNORE INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
    const base = new Date('2020-01-01T00:00:00.000Z').getTime()
    const insertDoc = (title: string, idx: number): string => {
      const docId = crypto.randomUUID()
      const ts = new Date(base + idx * 60_000).toISOString()
      db.query(
        `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, status, sort, level, created_at, updated_at)
         VALUES (?, ?, NULL, ?, 'document', ?, 'note', 0, 0, ?, ?)`,
      ).run(docId, nb, docId, title, ts, ts)
      return docId
    }
    // 401 篇：第 0 篇最老且带实体（有连接），其余 400 篇较新孤立 → 最老文档被池裁剪出总览
    const oldDoc = insertDoc('最老文档', 0)
    const oldB = crypto.randomUUID()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'paragraph', '提及甲的内容', 0, 1, ?, ?)`,
    ).run(oldB, nb, oldDoc, oldDoc, new Date(base).toISOString(), new Date(base).toISOString())
    registerMentions(oldB, [{ anchor: '概念甲', kind: 'concept' }])
    for (let i = 1; i <= 400; i++) insertDoc(`文档${i}`, i)

    const { nodes } = queryGraph(db, { mode: 'docs', maxNodes: 100 })
    expect(nodes.length).toBeGreaterThan(0)
    expect(nodes.some((n) => n.id === oldDoc)).toBe(false)
  })

  test('docs 模式 REST：总览 + 实体锚点 400', async () => {
    seedDocGraph()
    const res = await app.fetch(new Request('http://localhost/api/v1/graph?mode=docs'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const nodes = body.nodes as Array<Record<string, unknown>>
    expect(nodes.length).toBe(4)
    expect(nodes[0]).toMatchObject({ type: 'doc', kind: 'doc', mention_count: expect.any(Number) })

    const bad = await app.fetch(
      new Request('http://localhost/api/v1/graph?mode=docs&center=x&center_type=entity'),
    )
    expect(bad.status).toBe(400)
  })

  test('docs 模式 q：总览按标题子串过滤（聚焦搜索）', async () => {
    seedDocGraph()
    const { nodes } = queryGraph(getDb(), { mode: 'docs', maxNodes: 10, q: 'D3' })
    expect(nodes.map((n) => n.display)).toEqual(['D3'])
    const { nodes: none } = queryGraph(getDb(), { mode: 'docs', maxNodes: 10, q: '不存在的标题' })
    expect(none).toEqual([])
  })
})

describe('别名与合并（E5）', () => {
  test('resolveAlias / addAlias 幂等；registerMentions 命中别名路由到规范实体', () => {
    const db = getDb()
    seedDoc({ docTitle: 'T', blocks: [{ id: 'al-b1', content: '' }] })
    const e = upsertEntityDirect('向量数据库', 'concept')
    addAlias(db, '向量库', e.id)
    expect(resolveAlias(db, '向量库')).toBe(e.id)
    expect(resolveAlias(db, '不存在')).toBeNull()

    // 别名命中：挂到规范实体，不新建
    registerMentions('al-b1', [{ anchor: '向量库', kind: 'concept' }])
    expect(findEntityByName(db, '向量数据库')!.mention_count).toBe(1)
    expect(findEntityByName(db, '向量库')).toBeNull()
  })

  test('mergeEntities：迁移提及、重算计数、别名搬移、from 删除', () => {
    const db = getDb()
    seedDoc({ docTitle: 'T1', blocks: [{ id: 'm-b1', content: '' }] })
    seedDoc({ docTitle: 'T2', blocks: [{ id: 'm-b2', content: '' }] })
    registerMentions('m-b1', [{ anchor: '向量数据库', kind: 'concept' }])
    registerMentions('m-b2', [{ anchor: 'sqlite-vec', kind: 'tool' }])
    const a = findEntityByName(db, '向量数据库')!
    const b = findEntityByName(db, 'sqlite-vec')!

    mergeEntities(db, b.id, a.id)
    expect(getEntityById(db, b.id)).toBeNull()
    const merged = getEntityById(db, a.id)!
    expect(merged.mention_count).toBe(2) // 两条提及迁移后重算
    // from 的规范化名成为别名
    expect(resolveAlias(db, 'sqlite-vec')).toBe(a.id)
    // 此后抽取 sqlite-vec 直接路由到向量数据库
    seedDoc({ docTitle: 'T3', blocks: [{ id: 'm-b3', content: '' }] })
    registerMentions('m-b3', [{ anchor: 'sqlite-vec', kind: 'tool' }])
    expect(getEntityById(db, a.id)!.mention_count).toBe(3)
  })

  test('findPotentialDuplicates：子串包含 → substring（词典建议）；ASCII 编辑距离 → typo（自动合并）', () => {
    const db = getDb()
    seedDoc({ docTitle: 'T', blocks: [{ id: 'dup-b1', content: '' }] })
    const a = upsertEntityDirect('混合检索', 'concept')
    const b = upsertEntityDirect('混合检索架构', 'concept')
    const c = upsertEntityDirect('qdrant', 'tool')
    const d = upsertEntityDirect('qdrnt', 'tool')
    const e = upsertEntityDirect('中文检索', 'concept')
    const f = upsertEntityDirect('rust', 'tool') // 长度 4 的 ASCII：距离 ≤1 也不自动合（rust/rush 真实不同实体）
    const g = upsertEntityDirect('rush', 'tool')
    addMention(db, a.id, 'dup-b1', '混合检索')
    addMention(db, b.id, 'dup-b1', '混合检索架构')
    addMention(db, c.id, 'dup-b1', 'qdrant')
    addMention(db, d.id, 'dup-b1', 'qdrnt')
    addMention(db, e.id, 'dup-b1', '中文检索')
    addMention(db, f.id, 'dup-b1', 'rust')
    addMention(db, g.id, 'dup-b1', 'rush')
    const groups = findPotentialDuplicates(db, 8)
    // 子串包含 → substring 信号（词典建议，不自动合）
    expect(groups.some((g2) => g2.signal === 'substring' && g2.reason.includes('的一部分'))).toBe(true)
    // ASCII 编辑距离（qdrant/qdrnt）→ typo 信号（自动合并）
    expect(groups.some((g2) => g2.signal === 'typo' && g2.a.display === 'qdrant' && g2.b.display === 'qdrnt')).toBe(true)
    // 长度 4 的 ASCII 近拼写（rust/rush）降级为不提示（宁漏合不错合）
    expect(groups.some((g2) => g2.a.display === 'rust' && g2.b.display === 'rush')).toBe(false)
    // CJK 近音但不同概念（中文检索 vs 混合检索）不提示
    expect(groups.some((g2) => g2.a.display === '中文检索' && g2.b.display === '混合检索')).toBe(false)
  })
})

// 便捷：直接 upsert 实体（绕过 registerMentions 的别名路由）
function upsertEntityDirect(name: string, kind: string) {
  return upsertEntity(getDb(), { name, display: name, kind })
}

describe('graph REST API', () => {
  test('GET /graph：总览契约形状', async () => {
    seedCooccurrence()
    const res = await app.fetch(new Request('http://localhost/api/v1/graph'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const nodes = body.nodes as Array<Record<string, unknown>>
    const edges = body.edges as Array<Record<string, unknown>>
    expect(body.center).toBeNull()
    expect(Array.isArray(nodes)).toBe(true)
    expect(Array.isArray(edges)).toBe(true)
    expect(nodes.length).toBe(3)
    expect(nodes[0]).toMatchObject({ kind: expect.any(String), mention_count: expect.any(Number), distance: 0 })
    expect(typeof nodes[0]!.id).toBe('string')
    expect(edges[0]).toMatchObject({ source: expect.any(String), target: expect.any(String), weight: expect.any(Number) })
  })

  test('GET /graph?center= 404（实体/文档不存在）；center_type 非法 400', async () => {
    seedCooccurrence()
    const ghost = await app.fetch(new Request('http://localhost/api/v1/graph?center=ghost&center_type=entity'))
    expect(ghost.status).toBe(404)
    const ghostDoc = await app.fetch(new Request('http://localhost/api/v1/graph?center=ghost&center_type=doc'))
    expect(ghostDoc.status).toBe(404)
    const bad = await app.fetch(new Request('http://localhost/api/v1/graph?center=x&center_type=unknown'))
    expect(bad.status).toBe(400)
    const orphan = await app.fetch(new Request('http://localhost/api/v1/graph?center_type=entity'))
    expect(orphan.status).toBe(400)
  })

  test('GET /graph 参数钳制（min_mention 上限 / kind 多值）', async () => {
    seedCooccurrence()
    const res = await app.fetch(
      new Request('http://localhost/api/v1/graph?min_mention=9999&max_nodes=9999&kind=tool,person'),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const nodes = body.nodes as Array<Record<string, unknown>>
    expect(nodes.length).toBe(0) // min_mention 被钳到 100，无人达标
  })

  test('中心实体：锚点进图', async () => {
    seedCooccurrence()
    const idD = entityId(D)!
    const res = await app.fetch(
      new Request(`http://localhost/api/v1/graph?center=${idD}&center_type=entity`),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const nodes = body.nodes as Array<Record<string, unknown>>
    expect(nodes.map((n) => n.name)).toContain(norm(D))
    expect((body.center as Record<string, unknown>).id).toBe(idD)
  })
})
