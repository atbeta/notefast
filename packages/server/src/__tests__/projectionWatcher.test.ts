/**
 * 投影监听队列（RFC 0007 D6）。
 *
 * 这些用例**直接投递事件**（`push`），不依赖真实 fs 通知：
 * macOS 上 `/tmp` 经符号链接（→ `/private/...`）FSEvents 不投递，涉及真实监听的测试会不稳定。
 * 队列本身（合并、宽限窗口、串行、幂等）才是这里要钉住的东西。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeDb, getDb, initDb } from '../db'
import { fetchDocBlocks, getDocById, getLiveDocById } from '../store/blocks'
import { getProjectionFileByPath, listProjectionFiles } from '../store/projectionFiles'
import { createSerialLock } from '../projection/lock'
import { ingestProjectionFile, type ProjectionContext } from '../projection/ingest'
import { createProjectionQueue } from '../projection/watcher'
import { resolveProjectionConfig } from '../projection/config'

let testDir: string
let root: string
let ctx: ProjectionContext

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-proj-watch-'))
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

function removeMd(rel: string): void {
  unlinkSync(join(root, rel))
}

function mid(rel: string): string | null {
  return getProjectionFileByPath(getDb(), ctx.notebookId, rel)?.doc_id ?? null
}

describe('监听队列：事件驱动导入', () => {
  test('change 事件把新文件导入库里', async () => {
    const q = createProjectionQueue(ctx)
    writeMd('监听新建.md', '内容\n')
    q.push('change', '监听新建.md')
    await q.idle()
    await q.close()

    const docId = mid('监听新建.md')
    expect(docId).toBeTruthy()
    expect(getDocById(getDb(), docId!)!.content).toBe('监听新建')
  })

  test('同路径连续 change 合并，最终以磁盘内容为准', async () => {
    const q = createProjectionQueue(ctx)
    writeMd('合并.md', '第一版\n')
    q.push('change', '合并.md')
    writeMd('合并.md', '第二版\n')
    q.push('change', '合并.md')
    q.push('change', '合并.md')
    await q.idle()
    await q.close()

    const docId = mid('合并.md')!
    expect(
      fetchDocBlocks(getDb(), docId).filter((b) => b.id !== docId).map((b) => b.content),
    ).toEqual(['第二版'])
  })

  test('unlink 在宽限窗口内文件又出现 → 当作没删', async () => {
    const q = createProjectionQueue(ctx, { unlinkGraceMs: 120 })
    writeMd('闪断.md', '内容\n')
    await ingestProjectionFile(ctx, '闪断.md')
    const docId = mid('闪断.md')!

    // 编辑器「删除后重建」的保存策略：先 unlink 再立刻写回
    removeMd('闪断.md')
    q.push('unlink', '闪断.md')
    writeMd('闪断.md', '内容\n')

    await q.idle()
    await q.close()

    // 文档没有进回收站
    expect(getLiveDocById(getDb(), docId)).not.toBeNull()
    expect(mid('闪断.md')).toBe(docId)
  })

  test('unlink 窗口过后文件确实不在 → 进回收站', async () => {
    const q = createProjectionQueue(ctx, { unlinkGraceMs: 60 })
    writeMd('真删除.md', '内容\n')
    await ingestProjectionFile(ctx, '真删除.md')
    const docId = mid('真删除.md')!

    removeMd('真删除.md')
    q.push('unlink', '真删除.md')
    await q.idle()
    await q.close()

    expect(getLiveDocById(getDb(), docId)).toBeNull()
    // 映射行保留，文件回来时能认领
    expect(mid('真删除.md')).toBe(docId)
  })

  test('从没导入过的文件消失：不产生任何动作', async () => {
    const q = createProjectionQueue(ctx, { unlinkGraceMs: 30 })
    q.push('unlink', '无关文件.md')
    await q.idle()
    await q.close()
    // 没有映射行，也不该凭空冒出一个
    expect(mid('无关文件.md')).toBeNull()
  })

  test('非 markdown / 忽略路径的事件被丢弃', async () => {
    const q = createProjectionQueue(ctx)
    q.push('change', '图.png')
    q.push('change', '.obsidian/workspace.json')
    q.push('change', 'node_modules/a.md')
    await q.idle()
    await q.close()
    expect(mid('图.png')).toBeNull()
    expect(mid('.obsidian/workspace.json')).toBeNull()
    expect(mid('node_modules/a.md')).toBeNull()
  })

  test('串行执行：多个文件的事件全部处理，不互相丢失', async () => {
    const q = createProjectionQueue(ctx)
    for (let i = 0; i < 5; i++) {
      writeMd(`批量/第${i}篇.md`, `内容 ${i}\n`)
      q.push('change', `批量/第${i}篇.md`)
    }
    await q.idle()
    await q.close()

    const rels = listProjectionFiles(getDb(), ctx.notebookId).map((r) => r.rel_path)
    for (let i = 0; i < 5; i++) expect(rels).toContain(`批量/第${i}篇.md`)
  })

  test('单个文件出错不影响其他文件', async () => {
    const errors: string[] = []
    const q = createProjectionQueue(ctx, { onError: (rel) => errors.push(rel) })
    // 一个不存在的路径 + 两个正常文件
    q.push('change', '不存在.md')
    writeMd('好文件A.md', 'A\n')
    writeMd('好文件B.md', 'B\n')
    q.push('change', '好文件A.md')
    q.push('change', '好文件B.md')
    await q.idle()
    await q.close()

    expect(mid('好文件A.md')).toBeTruthy()
    expect(mid('好文件B.md')).toBeTruthy()
  })

  test('close 清理挂起的 unlink 定时器，不留下后续动作', async () => {
    const q = createProjectionQueue(ctx, { unlinkGraceMs: 5000 })
    writeMd('挂起.md', '内容\n')
    await ingestProjectionFile(ctx, '挂起.md')
    const docId = mid('挂起.md')!

    removeMd('挂起.md')
    q.push('unlink', '挂起.md')
    await q.close()

    // 定时器已清理：文档不会被删
    await new Promise((r) => setTimeout(r, 80))
    expect(getLiveDocById(getDb(), docId)).not.toBeNull()
  })

  test('onResult 报出每次导入的结果', async () => {
    const seen: string[] = []
    const q = createProjectionQueue(ctx, { onResult: (r) => seen.push(`${r.action}:${r.relPath}`) })
    writeMd('结果.md', '内容\n')
    q.push('change', '结果.md')
    await q.idle()
    await q.close()
    expect(seen).toContain('created:结果.md')
  })
})
