import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb, getDb } from '../db'
import { insertBlock, nowTimestamp, softDeleteBlocks } from '../store/blocks'
import { runFeedSuppressed, getChangesAnchor, pruneStaleChanges } from '../store/changeFeed'
import { SqliteVecVectorStore, dropGeneration, dropStaleVectorGenerations } from '../ai/vectorStoreVec'
import {
  purgeExpiredTombstones,
  runMaintenancePass,
} from '../services/maintenance'
import {
  _resetProtocolManagerForTests,
} from '../sync/protocolManager'
import { _resetProtocolConfigForTests } from '../sync/protocolConfig'

/**
 * 周期维护任务（存储膨胀 purge）：
 * - purgeExpiredTombstones：只物理清除「过期且顶层」的 tombstone，级联清
 *   FTS / 修订 / 文档快照；保留期内、已删父下的后代、有存活子块的 tombstone 不动
 * - 物理删除不产生 change feed 行（runFeedSuppressed 临界区）
 * - 未配置同步时 pruneStaleChanges 时间裁剪（publishedSeq 保护）
 * - retired / failed 向量 generation 的虚拟表与条目清理
 */

let testDir: string
let notebookId: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-maintenance-'))
  notebookId = initDb(testDir).notebookId
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  // 隔离协议配置残留（其他测试文件可能配置过同步）
  _resetProtocolManagerForTests()
  _resetProtocolConfigForTests()
  getDb().exec(`
    DELETE FROM blocks;
    DELETE FROM entity_changes;
    DELETE FROM block_revisions;
    DELETE FROM doc_snapshots;
    DELETE FROM vector_generations;
    DELETE FROM vector_entries;
  `)
})

function insertRow(id: string, content: string, parentId: string | null, updatedAt: string): void {
  insertBlock(getDb(), {
    id,
    notebook_id: notebookId,
    parent_id: parentId,
    root_id: parentId ?? id,
    type: parentId ? 'paragraph' : 'document',
    content,
    sort: 0,
    level: 0,
    now: updatedAt,
  })
  // insertBlock 的 now 参数可能被内部覆盖，直接落库保证时间可控
  getDb().query('UPDATE blocks SET updated_at = ? WHERE id = ?').run(updatedAt, id)
}

/** 把块软删并把 updated_at 拨回删除时刻（模拟 30+ 天前的删除） */
function tombstoneAt(id: string, deletedAt: string): void {
  softDeleteBlocks(getDb(), [id])
  getDb().query('UPDATE blocks SET updated_at = ? WHERE id = ?').run(deletedAt, id)
}

const OLD = '2026-01-01 00:00:00.000'
const FRESH = nowTimestamp()
const CUTOFF = '2026-06-01 00:00:00'

describe('purgeExpiredTombstones（孤儿 tombstone 物理清理）', () => {
  test('过期顶层 tombstone 整棵清除；保留期内 / 有存活子块的跳过', () => {
    const db = getDb()
    // 过期已删文档 X + 子块 X1（整棵过期 tombstone）
    insertRow('doc-x', '已删文档', null, OLD)
    insertRow('x1', '子块', 'doc-x', OLD)
    tombstoneAt('doc-x', OLD)
    tombstoneAt('x1', OLD)
    // 保留期内的删除 Y
    insertRow('doc-y', '新删文档', null, FRESH)
    tombstoneAt('doc-y', FRESH)
    // 存活文档 D + 过期 tombstone 子块 D1（整篇保存孤儿）
    insertRow('doc-d', '存活文档', null, FRESH)
    insertRow('d1', '被替换旧段', 'doc-d', OLD)
    tombstoneAt('d1', OLD)
    // 已删父 + 存活子：不能连带清掉恢复过的内容
    insertRow('doc-z', '已删但有活子', null, OLD)
    insertRow('z1', '恢复的活子', 'doc-z', FRESH)
    tombstoneAt('doc-z', OLD)

    // 修订与文档快照（应随清）
    db.query(`INSERT INTO block_revisions (block_id, rev, content, content_hash, created_at)
              VALUES ('x1', 1, 'v1', 'h1', '2026-01-01')`).run()
    db.query(`INSERT INTO doc_snapshots (doc_id, rev, content, content_hash, created_at)
              VALUES ('doc-x', 1, 'snap', 'h2', '2026-01-01')`).run()

    const result = runFeedSuppressed(db, () => purgeExpiredTombstones(db, CUTOFF))

    // 清除：doc-x + x1（级联含父）；d1（孤儿子块）
    expect(result.blocks).toBe(3)
    expect(result.revisions).toBe(1)
    expect(result.docSnapshots).toBe(1)
    const alive = db.query('SELECT id FROM blocks').all() as Array<{ id: string }>
    const aliveIds = alive.map((r) => r.id).sort()
    expect(aliveIds).toEqual(['doc-d', 'doc-y', 'doc-z', 'z1'])
    // FTS 行跟随触发器清除
    const fts = db.query("SELECT id FROM blocks_fts WHERE id IN ('doc-x', 'x1', 'd1')").all()
    expect(fts.length).toBe(0)
  })

  test('物理清除不产生 change feed 行（guard 抑制）', () => {
    const db = getDb()
    insertRow('doc-g', 'guard 文档', null, OLD)
    tombstoneAt('doc-g', OLD)
    const anchorBefore = getChangesAnchor(db)

    const r = runFeedSuppressed(db, () => purgeExpiredTombstones(db, CUTOFF))

    expect(r.blocks).toBe(1)
    expect(getChangesAnchor(db)).toBe(anchorBefore)
  })
})

describe('runMaintenancePass（feed 时间裁剪 + 编排）', () => {
  test('未配置同步且从未发布：过期行全量裁剪并标记 feedPruned', () => {
    const db = getDb()
    // 直接灌 entity_changes（绕开 trigger），拨 changed_at 到过期/新鲜两档
    db.query(`
      INSERT INTO entity_changes (seq, entity, entity_id, is_erased, actor, changed_at)
      VALUES (1, 'block', 'b1', 0, 'server', '2026-01-01 00:00:00'),
             (2, 'block', 'b2', 0, 'server', '2026-08-01 00:00:00')
    `).run()

    const result = runMaintenancePass()

    expect(result.feedRows).toBe(1)
    const left = db.query('SELECT seq FROM entity_changes').all() as Array<{ seq: number }>
    expect(left.map((r) => r.seq)).toEqual([2])
  })

  test('曾发布过（publishedSeq>0）：只裁已发布区间的过期行，未发布行不动', () => {
    const db = getDb()
    db.query(`
      INSERT INTO entity_changes (seq, entity, entity_id, is_erased, actor, changed_at)
      VALUES (1, 'block', 'b1', 0, 'server', '2026-01-01 00:00:00'),
             (2, 'block', 'b2', 0, 'server', '2026-01-02 00:00:00'),
             (3, 'block', 'b3', 0, 'server', '2026-06-15 00:00:00')
    `).run()

    // 直接验证 store 层规则：publishedSeq=2 → seq 1、2 过期被裁，seq 3（未发布）保留
    const pruned = pruneStaleChanges(db, '2026-06-01 00:00:00', 2)
    expect(pruned).toBe(2)
    const left = db.query('SELECT seq FROM entity_changes').all() as Array<{ seq: number }>
    expect(left.map((r) => r.seq)).toEqual([3])
  })
})

describe('dropGeneration（sqlite-vec 旧代清理）', () => {
  test('retired / failed generation 的虚拟表、触发器与条目全部清掉', async () => {
    const db = getDb()
    const store = new SqliteVecVectorStore()
    await store.init()
    await store.createGeneration('gen-1', 'model-a', 2)
    await store.createGeneration('gen-2', 'model-a', 2)
    db.query("UPDATE vector_generations SET status = 'retired' WHERE id = 'gen-1'").run()
    db.query("UPDATE vector_generations SET status = 'failed' WHERE id = 'gen-2'").run()

    const dropped = dropStaleVectorGenerations()

    expect(dropped).toBe(2)
    const rows = db.query("SELECT id FROM vector_generations WHERE id IN ('gen-1', 'gen-2')").all()
    expect(rows.length).toBe(0)
    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vec_blocks\\_%' ESCAPE '\\'",
    ).all()
    expect(tables.length).toBe(0)
    const triggers = db.query(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'vec_blocks\\_%' ESCAPE '\\'",
    ).all()
    expect(triggers.length).toBe(0)
  })

  test('dropGeneration 对不存在的 generation 幂等返回 true', () => {
    expect(dropGeneration('never-existed')).toBe(true)
  })
})
