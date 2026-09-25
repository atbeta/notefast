/**
 * 投影状态视图（RFC 0007 S3）。
 *
 * 给用户的三个问题：文件夹在哪、跟上没有、出过冲突吗。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeDb, getDb, initDb } from '../db'
import { getDocById } from '../store/blocks'
import { getProjectionFileByPath } from '../store/projectionFiles'
import { createSerialLock } from '../projection/lock'
import { ingestProjectionFile, type ProjectionContext } from '../projection/ingest'
import { writeProjectionDoc } from '../projection/writeback'
import { projectionStatus } from '../projection/status'
import { resolveProjectionConfig } from '../projection/config'

let testDir: string
let root: string
let ctx: ProjectionContext

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-proj-status-'))
  const { notebookId } = initDb(testDir)
  root = join(testDir, 'notes')
  mkdirSync(root, { recursive: true })
  ctx = {
    db: getDb(),
    notebookId,
    config: resolveProjectionConfig(root, {}),
    lock: createSerialLock(),
  }
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

function writeMd(rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf-8')
}

describe('projectionStatus', () => {
  test('未启用 → 全部计数为 0，root 为 null', () => {
    const view = projectionStatus(getDb(), ctx.notebookId, { enabled: false, root: null })
    expect(view.enabled).toBe(false)
    expect(view.root).toBeNull()
    expect(view.files).toBe(0)
    expect(view.liveFiles).toBe(0)
    expect(view.patchableFiles).toBe(0)
    expect(view.conflicts.count24h).toBe(0)
    expect(view.conflicts.recent).toEqual([])
  })

  test('启用后报出文件数与可局部写回的文件数', async () => {
    writeMd('状态A.md', '内容 A\n')
    writeMd('状态B.md', '内容 B\n')
    await ingestProjectionFile(ctx, '状态A.md')
    await ingestProjectionFile(ctx, '状态B.md')

    const view = projectionStatus(getDb(), ctx.notebookId, { enabled: true, root })
    expect(view.enabled).toBe(true)
    expect(view.root).toBe(root)
    expect(view.files).toBeGreaterThanOrEqual(2)
    expect(view.liveFiles).toBeGreaterThanOrEqual(2)
    // 刚导入的文件都有区间记录 → 可局部写回
    expect(view.patchableFiles).toBeGreaterThanOrEqual(2)
    expect(view.patchableFiles).toBeLessThanOrEqual(view.files)
  })

  test('liveFiles 反映回收站状态：文件删掉后文档不再计入 live', async () => {
    writeMd('状态删除.md', '内容\n')
    const r = await ingestProjectionFile(ctx, '状态删除.md')
    const before = projectionStatus(getDb(), ctx.notebookId, { enabled: true, root })

    // 库里软删除（等价于用户删了这篇，而文件还在）
    const db = getDb()
    db.query('UPDATE blocks SET is_deleted = 1 WHERE id = ?').run(r.docId!)

    const after = projectionStatus(getDb(), ctx.notebookId, { enabled: true, root })
    expect(after.liveFiles).toBe(before.liveFiles - 1)
    // 映射行还在（文件还在磁盘上），所以 files 不变
    expect(after.files).toBe(before.files)
  })

  test('冲突计数与最近列表来自审计日志', async () => {
    writeMd('状态冲突.md', '原内容\n')
    await ingestProjectionFile(ctx, '状态冲突.md')
    const m = getProjectionFileByPath(getDb(), ctx.notebookId, '状态冲突.md')!
    // 外部改动
    writeMd('状态冲突.md', '外部改的\n')

    const doc = getDocById(getDb(), m.doc_id)!
    const out = await writeProjectionDoc(ctx, {
      doc,
      relPath: '状态冲突.md',
      expectedSha: m.content_sha256,
      content: '库里的内容\n',
    })
    expect(out.kind).toBe('conflict')

    const view = projectionStatus(getDb(), ctx.notebookId, { enabled: true, root })
    expect(view.conflicts.count24h).toBeGreaterThanOrEqual(1)
    expect(view.conflicts.recent.length).toBeGreaterThanOrEqual(1)
    const first = view.conflicts.recent[0]!
    expect(first.relPath).toBe('状态冲突.md')
    expect(first.conflictPath).toBeTruthy()
  })
})
