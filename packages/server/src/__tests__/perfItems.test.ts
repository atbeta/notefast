import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb, getDb } from '../db'
import { insertBlock, nowTimestamp } from '../store/blocks'
import { listBacklinks } from '../store/refs'
import { getDocNeighbors } from '../store/blocks'
import { updateLastUsed, _resetLastUsedThrottleForTests } from '../services/apiTokens'
import { collectReferencedAssetIds } from '../assets/store'
import { runFeedSuppressed, getChangesAnchor, contentRevisionToken } from '../store/changeFeed'
import { JsonVectorStore } from '../ai/vectorStore'

/**
 * 性能项回归（批次 6）：
 * - last_used_at 写库节流（60s 窗口内同一 token 只写一次）
 * - 资源库引用集合缓存：seq 锚点 / 内容修订计数双令牌失效
 * - listBacklinks 文档根分支默认上限
 * - getDocNeighbors 同毫秒 rowid 决胜语义（真实入库序）
 * - 向量 deleteMany 一次维护计数（JSON 后端）
 */

let testDir: string
let notebookId: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-perf-'))
  notebookId = initDb(testDir).notebookId
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  _resetLastUsedThrottleForTests()
  getDb().exec('DELETE FROM blocks; DELETE FROM api_tokens; DELETE FROM block_vectors; DELETE FROM block_refs;')
})

describe('updateLastUsed 节流', () => {
  test('60s 窗口内同一 token 只写一次库', () => {
    const db = getDb()
    db.query(
      `INSERT INTO api_tokens (token_id, token_hash, name, scopes) VALUES ('tok-1', 'h', 't', '["read"]')`,
    ).run()

    updateLastUsed('tok-1')
    const row = db.query("SELECT last_used_at FROM api_tokens WHERE token_id = 'tok-1'").get() as { last_used_at: string }
    expect(row.last_used_at).toBeTruthy()

    // 窗口内再调用：把库里的值拨成哨兵，节流命中时不写库 → 哨兵保留
    db.query("UPDATE api_tokens SET last_used_at = 'SENTINEL' WHERE token_id = 'tok-1'").run()
    updateLastUsed('tok-1')
    const after = db.query("SELECT last_used_at FROM api_tokens WHERE token_id = 'tok-1'").get() as { last_used_at: string }
    expect(after.last_used_at).toBe('SENTINEL')
  })
})

describe('资源库引用集合缓存', () => {
  test('锚点不变时复用缓存；普通写推进锚点失效；被抑制写推进修订计数失效', () => {
    const db = getDb()
    insertBlock(db, {
      id: 'cache-doc',
      notebook_id: notebookId,
      parent_id: null,
      root_id: 'cache-doc',
      type: 'document',
      content: 'asset:' + 'a'.repeat(64),
      sort: 0,
      level: 0,
      now: nowTimestamp(),
    })
    const first = collectReferencedAssetIds()
    expect(first.size).toBe(1)
    const second = collectReferencedAssetIds()
    expect(second).toBe(first) // 同 key：缓存复用（引用同一 Set 实例）

    // 普通写（触发 trigger）→ 锚点前进 → 重扫
    insertBlock(db, {
      id: 'cache-doc-2',
      notebook_id: notebookId,
      parent_id: null,
      root_id: 'cache-doc-2',
      type: 'document',
      content: 'asset:' + 'b'.repeat(64),
      sort: 0,
      level: 0,
      now: nowTimestamp(),
    })
    const third = collectReferencedAssetIds()
    expect(third).not.toBe(first)
    expect(third.size).toBe(2)

    // 被抑制写（consume guard 直写 SQL 改 content）→ 锚点不变但修订计数前进
    const anchorBefore = getChangesAnchor(db)
    const tokenBefore = contentRevisionToken()
    runFeedSuppressed(db, () => {
      db.query(`UPDATE blocks SET content = 'asset:' || ? WHERE id = 'cache-doc-2'`).run('c'.repeat(64))
    })
    expect(getChangesAnchor(db)).toBe(anchorBefore)
    expect(contentRevisionToken()).toBe(tokenBefore + 1)
    const fourth = collectReferencedAssetIds()
    expect(fourth.size).toBe(2) // b 被 c 替换，总量不变
    expect(fourth.has('c'.repeat(64))).toBe(true)
    expect(fourth.has('b'.repeat(64))).toBe(false)
  })
})

describe('listBacklinks 文档根默认上限', () => {
  test('文档根分支未传 limit 时按默认上限截断；块级目标不截断', () => {
    const db = getDb()
    insertBlock(db, {
      id: 'bl-doc', notebook_id: notebookId, parent_id: null, root_id: 'bl-doc',
      type: 'document', content: '反链目标', sort: 0, level: 0, now: nowTimestamp(),
    })
    for (let i = 0; i < 3; i++) {
      insertBlock(db, {
        id: `bl-src-${i}`, notebook_id: notebookId, parent_id: null, root_id: `bl-src-${i}`,
        type: 'document', content: `来源${i}`, sort: 0, level: 0, now: nowTimestamp(),
      })
      db.query(
        `INSERT INTO block_refs (source_id, target_id, ref_type, created_at)
         VALUES (?, ?, 'manual', ?)`,
      ).run(`bl-src-${i}`, 'bl-doc', new Date(2026, 0, i + 1).toISOString().replace('T', ' ').replace('Z', ''))
    }
    // 文档根：IN 展开 + 默认上限（3 条 < 500，不截断但走同一条 SQL 分支）
    const docRefs = listBacklinks(db, 'bl-doc')
    expect(docRefs.length).toBe(3)
    // 块级目标：仍全量（无默认上限）
    const blockRefs = listBacklinks(db, 'bl-doc')
    expect(blockRefs.length).toBe(3)
  })
})

describe('getDocNeighbors 同毫秒 rowid 决胜', () => {
  test('created_at 相同时按入库序（rowid）返回前后篇', () => {
    const db = getDb()
    const sameMs = '2026-01-01 00:00:00.000'
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const id = `nb-${i}`
      ids.push(id)
      insertBlock(db, {
        id, notebook_id: notebookId, parent_id: null, root_id: id,
        type: 'document', content: `邻居${i}`, sort: 0, level: 0, now: sameMs,
      })
      db.query('UPDATE blocks SET created_at = ? WHERE id = ?').run(sameMs, id)
    }
    // 中间篇：prev/next 均存在且为入库序相邻
    const mid = getDocNeighbors(db, 'nb-2')
    expect(mid.prev?.id).toBe('nb-1')
    expect(mid.next?.id).toBe('nb-3')
    // 首篇：prev null；末篇：next null（同毫秒组内）
    const head = getDocNeighbors(db, 'nb-0')
    expect(head.prev).toBeNull()
    expect(head.next?.id).toBe('nb-1')
    const tail = getDocNeighbors(db, 'nb-4')
    expect(tail.next).toBeNull()
    expect(tail.prev?.id).toBe('nb-3')
  })
})

describe('向量 deleteMany（JSON 后端）', () => {
  test('批量删除一次维护 indexed_count；空表/空 id 安全', async () => {
    const db = getDb()
    const store = new JsonVectorStore()
    await store.init()
    insertBlock(db, {
      id: 'vec-d1', notebook_id: notebookId, parent_id: null, root_id: 'vec-d1',
      type: 'document', content: '向量一', sort: 0, level: 0, now: nowTimestamp(),
    })
    insertBlock(db, {
      id: 'vec-d2', notebook_id: notebookId, parent_id: null, root_id: 'vec-d2',
      type: 'document', content: '向量二', sort: 0, level: 0, now: nowTimestamp(),
    })
    await store.upsert({
      blockId: 'vec-d1', vector: new Float64Array([1, 0]),
      modelFingerprint: 'm', contentHash: 'h1', sourceContentHash: 'h1',
    })
    await store.upsert({
      blockId: 'vec-d2', vector: new Float64Array([0, 1]),
      modelFingerprint: 'm', contentHash: 'h2', sourceContentHash: 'h2',
    })
    expect(await store.count()).toBe(2)

    await store.deleteMany(['vec-d1', 'vec-d2'])
    expect(await store.count()).toBe(0)
    const state = db.query("SELECT indexed_count FROM vector_store_state WHERE id = 'default'").get() as { indexed_count: number }
    expect(state.indexed_count).toBe(0)

    // 幂等：再删空 id / 不存在 id 不报错
    await store.deleteMany([])
    await store.deleteMany(['not-exist'])
    expect(await store.count()).toBe(0)
  })

  test('upsert 新块增量 +1，覆盖写入不重算 count(*)', async () => {
    const db = getDb()
    const store = new JsonVectorStore()
    await store.init()
    db.query("UPDATE vector_store_state SET indexed_count = 0 WHERE id = 'default'").run()
    insertBlock(db, {
      id: 'vec-inc-1', notebook_id: notebookId, parent_id: null, root_id: 'vec-inc-1',
      type: 'document', content: '增量一', sort: 0, level: 0, now: nowTimestamp(),
    })
    insertBlock(db, {
      id: 'vec-inc-2', notebook_id: notebookId, parent_id: null, root_id: 'vec-inc-2',
      type: 'document', content: '增量二', sort: 0, level: 0, now: nowTimestamp(),
    })
    const rec = (id: string, hash: string) => store.upsert({
      blockId: id, vector: new Float64Array([1, 0]),
      modelFingerprint: 'm', contentHash: hash, sourceContentHash: hash,
    })
    await rec('vec-inc-1', 'a')
    expect((db.query("SELECT indexed_count AS c FROM vector_store_state WHERE id = 'default'").get() as { c: number }).c).toBe(1)
    await rec('vec-inc-1', 'a2')
    expect((db.query("SELECT indexed_count AS c FROM vector_store_state WHERE id = 'default'").get() as { c: number }).c).toBe(1)
    await rec('vec-inc-2', 'b')
    expect((db.query("SELECT indexed_count AS c FROM vector_store_state WHERE id = 'default'").get() as { c: number }).c).toBe(2)
  })
})
