/**
 * 投影写回与冲突副本（RFC 0007 D4/D5）。
 *
 * 核心契约：**库赢**。外部工具在我们之后改过文件时，库里的版本继续写下去，
 * 外部版本另存为同目录副本——绝不静默覆盖任何一方。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { closeDb, getDb, initDb } from '../db'
import { getDocById } from '../store/blocks'
import { getProjectionFileByPath } from '../store/projectionFiles'
import { listProjectionBlockSpans } from '../store/projectionSpans'
import { insertDocFromMarkdown } from '../services/docImport'
import { createSerialLock } from '../projection/lock'
import { ingestProjectionFile, type ProjectionContext } from '../projection/ingest'
import { writeProjectionDoc, renderProjectionContent, type WritebackContext } from '../projection/writeback'
import { conflictCopyPath, conflictStamp } from '../projection/conflict'
import { CONFLICT_INFIX, isProjectionConflictName } from '../projection/paths'
import { resolveProjectionConfig } from '../projection/config'

let testDir: string
let root: string
let ctx: ProjectionContext
let wctx: WritebackContext

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-proj-wb-'))
  const { notebookId } = initDb(testDir)
  root = join(testDir, 'notes')
  mkdirSync(root, { recursive: true })
  const config = resolveProjectionConfig(root, {})
  const lock = createSerialLock()
  ctx = { db: getDb(), notebookId, config, lock }
  wctx = { db: getDb(), notebookId, config, lock }
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

function writeMd(rel: string, content: string): string {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf-8')
  return abs
}

function readMd(rel: string): string {
  return readFileSync(join(root, rel), 'utf-8')
}

/**
 * 该文件自己的冲突副本。
 * 必须按 stem 过滤：不同用例的文件落在同一目录，只按中缀数会把别人的算进来
 * （实测踩过：断言「没有副本」时数到了其他用例留下的 3 个）。
 */
function conflictsFor(rel: string): string[] {
  const abs = join(root, rel)
  const dir = dirname(abs)
  const stem = (abs.slice(dir.length + 1)).replace(/\.(md|markdown)$/i, '')
  return readdirSync(dir).filter((f) => f.startsWith(`${stem}${CONFLICT_INFIX}`))
}

describe('conflictStamp / conflictCopyPath', () => {
  test('时间戳格式 yyyyMMdd-HHmmss', () => {
    const d = new Date(2026, 8, 26, 14, 5, 3) // 2026-09-26 14:05:03
    expect(conflictStamp(d)).toBe('20260926-140503')
  })

  test('副本路径同目录、同 stem、带中缀', () => {
    const abs = join(root, 'sub', 'a.md')
    const p = conflictCopyPath(abs, '20260926-140503')
    expect(p).toBe(join(root, 'sub', `a${CONFLICT_INFIX}20260926-140503.md`))
  })

  test('同一秒内多次冲突追加序号，不互相覆盖', () => {
    const rel = '冲突序号.md'
    writeMd(rel, 'x')
    const abs = join(root, rel)
    const first = conflictCopyPath(abs, '20260926-140503')
    writeFileSync(first, '占位', 'utf-8')
    const second = conflictCopyPath(abs, '20260926-140503')
    expect(second).not.toBe(first)
    expect(second).toContain('-2.md')
  })

  test('生成的副本名被 isProjectionConflictName 认出来（两边同判据）', () => {
    const abs = join(root, 'a.md')
    const p = conflictCopyPath(abs, '20260926-140503')
    expect(isProjectionConflictName(p)).toBe(true)
  })
})

describe('writeProjectionDoc：正常写回', () => {
  test('内容一致 → unchanged，不写盘', async () => {
    writeMd('一致.md', '内容\n')
    await ingestProjectionFile(ctx, '一致.md')
    const doc = getDocById(getDb(), getProjectionFileByPath(getDb(), ctx.notebookId, '一致.md')!.doc_id)!
    const rendered = renderProjectionContent(getDb(), doc, readMd('一致.md'))
    const out = await writeProjectionDoc(wctx, { doc, relPath: '一致.md', content: rendered.content })
    expect(out.kind).toBe('skipped')
  })

  test('内容变了 → 写入并刷新映射指纹', async () => {
    writeMd('刷新.md', '原文\n')
    await ingestProjectionFile(ctx, '刷新.md')
    const mapping = getProjectionFileByPath(getDb(), ctx.notebookId, '刷新.md')!
    const before = mapping.content_sha256

    writeMd('刷新.md', '改后的文字\n\n新增段落\n')
    await ingestProjectionFile(ctx, '刷新.md')
    const doc = getDocById(getDb(), mapping.doc_id)!
    const rendered = renderProjectionContent(getDb(), doc, readMd('刷新.md'))
    // 内容已同步，写回应是 no-op
    const out = await writeProjectionDoc(wctx, { doc, relPath: '刷新.md', content: rendered.content })
    expect(out.kind).toBe('skipped')
    expect(getProjectionFileByPath(getDb(), ctx.notebookId, '刷新.md')!.content_sha256).not.toBe(before)
  })

  test('写回后映射指纹与磁盘一致（回声会被短路吞掉）', async () => {
    writeMd('回声.md', 'A\n\nB\n')
    await ingestProjectionFile(ctx, '回声.md')
    const mapping = getProjectionFileByPath(getDb(), ctx.notebookId, '回声.md')!

    // 库里改一个块
    const db = getDb()
    const child = db
      .query("SELECT id FROM blocks WHERE root_id = ? AND type = 'paragraph' ORDER BY sort")
      .get(mapping.doc_id) as { id: string }
    db.query('UPDATE blocks SET content = ? WHERE id = ?').run('A（改）', child.id)

    const doc = getDocById(getDb(), mapping.doc_id)!
    const rendered = renderProjectionContent(getDb(), doc, readMd('回声.md'))
    const out = await writeProjectionDoc(wctx, { doc, relPath: '回声.md', content: rendered.content })
    expect(out.kind).toBe('written')

    // 文件已更新
    expect(readMd('回声.md')).toContain('A（改）')
    // 紧接着的 ingest 应当是 unchanged —— 说明映射指纹已刷新
    const echo = await ingestProjectionFile(ctx, '回声.md')
    expect(echo.action).toBe('unchanged')
  })
})

describe('标题行的处理', () => {
  /**
   * 钉住一个踩过三次的地方：**偏移口径必须与 ingest 一致**。
   *
   * 文件里的标题行在库里是一个**真实的 heading 块**（当它与文件名不同时尤其明显），
   * 所以它必须参与块对齐。曾经在写回侧把它摘出去，结果块数与区间对不上、
   * 区间表整体失效退回整篇；也曾经在渲染时额外补一个标题行，结果文件里出现两个 H1。
   *
   * 正确语义：投影是**文件内容的镜像**。文件里的 `# 旧名` 对应库里内容为「旧名」的
   * heading 块；改文档根标题（doc.content）不该去改那个块的内容。
   */
  test('标题行是普通块：原样往返，不重复也不丢失', async () => {
    writeMd('带标题.md', '# 旧名\n\n正文\n')
    await ingestProjectionFile(ctx, '带标题.md')
    const m = getProjectionFileByPath(getDb(), ctx.notebookId, '带标题.md')!
    const doc = getDocById(getDb(), m.doc_id)!

    const rendered = renderProjectionContent(getDb(), doc, readMd('带标题.md'))
    // 恰好一个标题行，内容原样
    expect(rendered.content.match(/^#\s/gm)?.length).toBe(1)
    expect(rendered.content).toContain('# 旧名')
    expect(rendered.content).toContain('正文')
    // 没有变化 → 逐字节一致
    expect(rendered.content).toBe(readMd('带标题.md'))
  })

  test('改标题块的内容 → 写回时该行更新（它就是普通块）', async () => {
    writeMd('改标题块.md', '# 甲\n\n正文\n')
    await ingestProjectionFile(ctx, '改标题块.md')
    const m = getProjectionFileByPath(getDb(), ctx.notebookId, '改标题块.md')!
    const db = getDb()
    const heading = db
      .query("SELECT id FROM blocks WHERE root_id = ? AND type = 'heading'")
      .get(m.doc_id) as { id: string }
    db.query('UPDATE blocks SET content = ? WHERE id = ?').run('乙', heading.id)

    const doc = getDocById(getDb(), m.doc_id)!
    const rendered = renderProjectionContent(getDb(), doc, readMd('改标题块.md'))
    expect(rendered.content).toContain('# 乙')
    expect(rendered.content).not.toContain('# 甲')
    expect(rendered.content.match(/^#\s/gm)?.length).toBe(1)
  })

  test('文件没有标题行时不会被凭空加一个', async () => {
    writeMd('纯正文.md', '正文一\n\n正文二\n')
    await ingestProjectionFile(ctx, '纯正文.md')
    const m = getProjectionFileByPath(getDb(), ctx.notebookId, '纯正文.md')!
    const doc = getDocById(getDb(), m.doc_id)!
    const rendered = renderProjectionContent(getDb(), doc, readMd('纯正文.md'))
    expect(rendered.content).not.toContain('#')
    expect(rendered.content).toBe(readMd('纯正文.md'))
  })

  test('与文件名同文的 H1：内容不重复，但这类文件退回整篇（已知限制）', async () => {
    /**
     * 已知限制（**不是**本次引入）：当正文首行是「与文件名同文的 H1」时，
     * `insertDocFromMarkdown` 会把它剥离（标题 = 文件名，不该重复），
     * 但区间记录是按**完整 body** 解析的 —— 解析出 2 个顶层块，库里只有 1 个，
     * 对齐失败 → 区间表被清空 → 这类文件**永久退回整篇序列化**。
     *
     * 影响：排版不再逐字节保留（但内容不丢、不重复）。
     * 与 vault V-203 记录的「整篇退回后无法重建区间」同源。
     * 这里钉住现状，避免哪天它被当成新 bug 反复排查。
     */
    writeMd('同名.md', '# 同名\n\n正文\n')
    await ingestProjectionFile(ctx, '同名.md')
    const m = getProjectionFileByPath(getDb(), ctx.notebookId, '同名.md')!
    const doc = getDocById(getDb(), m.doc_id)!

    // 区间表确实为空 → 走整篇
    expect(listProjectionBlockSpans(getDb(), m.doc_id).length).toBe(0)
    const rendered = renderProjectionContent(getDb(), doc, readMd('同名.md'))
    expect(rendered.mode).toBe('full')
    // 但仍只出现一个标题行，内容不重复
    expect(rendered.content.match(/^#\s/gm)?.length).toBe(1)
    expect(rendered.content).toContain('正文')
  })
})

describe('writeProjectionDoc：冲突（D5 库赢）', () => {
  test('外部改过 → 落副本 + 库版本照写', async () => {
    writeMd('冲突.md', '库版本\n')
    await ingestProjectionFile(ctx, '冲突.md')
    const mapping = getProjectionFileByPath(getDb(), ctx.notebookId, '冲突.md')!
    // 记录「我们上次见到的 sha」
    const expectedSha = mapping.content_sha256

    // 外部工具在我们之后改了文件
    writeMd('冲突.md', '外部版本\n')

    const doc = getDocById(getDb(), mapping.doc_id)!
    const out = await writeProjectionDoc(wctx, {
      doc,
      relPath: '冲突.md',
      expectedSha,
      content: '库里的新内容\n',
    })

    expect(out.kind).toBe('conflict')
    if (out.kind !== 'conflict') throw new Error('unreachable')
    expect(out.conflictRelPath).toBeTruthy()
    expect(out.actualSha).not.toBe(expectedSha)

    // 库赢：原文件是库的版本
    expect(readMd('冲突.md')).toContain('库里的新内容')
    expect(readMd('冲突.md')).not.toContain('外部版本')
    // 副本存在，且装的是**库想写的版本**（外部版本本来就在用户文件里，不必抄）
    const copy = readMd(out.conflictRelPath!)
    expect(copy).toContain('库里的新内容')
  })

  test('副本名符合约定，且不被忽略规则排除（用户看得见）', async () => {
    writeMd('冲突可见.md', 'A\n')
    await ingestProjectionFile(ctx, '冲突可见.md')
    const mapping = getProjectionFileByPath(getDb(), ctx.notebookId, '冲突可见.md')!
    writeMd('冲突可见.md', '外部改了\n')

    const doc = getDocById(getDb(), mapping.doc_id)!
    const out = await writeProjectionDoc(wctx, {
      doc,
      relPath: '冲突可见.md',
      expectedSha: mapping.content_sha256,
      content: '库内容\n',
    })
    expect(out.kind).toBe('conflict')
    if (out.kind !== 'conflict') throw new Error('unreachable')

    const names = conflictsFor('冲突可见.md')
    expect(names.length).toBeGreaterThanOrEqual(1)
    expect(names.every((n) => isProjectionConflictName(n))).toBe(true)
  })

  test('不带 expectedSha → 不做并发校验，直接写（传给它的语义）', async () => {
    writeMd('不校验.md', 'A\n')
    await ingestProjectionFile(ctx, '不校验.md')
    const mapping = getProjectionFileByPath(getDb(), ctx.notebookId, '不校验.md')!
    writeMd('不校验.md', '外部改了\n')

    const doc = getDocById(getDb(), mapping.doc_id)!
    const out = await writeProjectionDoc(wctx, { doc, relPath: '不校验.md', content: '库内容\n' })
    expect(out.kind).toBe('written')
    expect(readMd('不校验.md')).toContain('库内容')
    // 没有产生副本
    expect(conflictsFor('不校验.md').length).toBe(0)
  })
})

describe('renderProjectionContent：局部改写 vs 整篇', () => {
  test('有区间记录 → patch 模式，且未改动块逐字节保留', async () => {
    writeMd('局部.md', '第一段\n\n第二段\n\n第三段\n')
    await ingestProjectionFile(ctx, '局部.md')
    const mapping = getProjectionFileByPath(getDb(), ctx.notebookId, '局部.md')!
    const diskBefore = readMd('局部.md')

    const db = getDb()
    const third = db
      .query("SELECT id FROM blocks WHERE root_id = ? AND type = 'paragraph' ORDER BY sort DESC LIMIT 1")
      .get(mapping.doc_id) as { id: string }
    db.query('UPDATE blocks SET content = ? WHERE id = ?').run('第三段（改）', third.id)

    const doc = getDocById(getDb(), mapping.doc_id)!
    const rendered = renderProjectionContent(getDb(), doc, diskBefore)
    expect(rendered.mode).toBe('patch')
    expect(rendered.content).toContain('第三段（改）')
    // 前两段原样
    expect(rendered.content).toContain('第一段')
    expect(rendered.content).toContain('第二段')
  })

  test('无区间记录（首投影）→ full 模式', async () => {
    const { docId } = insertDocFromMarkdown(getDb(), {
      notebookId: ctx.notebookId,
      title: '无区间',
      markdown: '内容\n',
    })
    const doc = getDocById(getDb(), docId)!
    const rendered = renderProjectionContent(getDb(), doc, null)
    expect(rendered.mode).toBe('full')
    expect(rendered.content).toContain('内容')
  })
})

describe('冲突副本会被入方向当普通文件导入', () => {
  test('副本进库，用户能看见（不静默丢失）', async () => {
    writeMd('副本导入.md', 'A\n')
    await ingestProjectionFile(ctx, '副本导入.md')
    const mapping = getProjectionFileByPath(getDb(), ctx.notebookId, '副本导入.md')!
    writeMd('副本导入.md', '外部改了\n')
    const doc = getDocById(getDb(), mapping.doc_id)!
    const out = await writeProjectionDoc(wctx, {
      doc,
      relPath: '副本导入.md',
      expectedSha: mapping.content_sha256,
      content: '库内容\n',
    })
    if (out.kind !== 'conflict' || !out.conflictRelPath) throw new Error('expected conflict')

    const ingested = await ingestProjectionFile(ctx, out.conflictRelPath)
    expect(ingested.action).toBe('created')
    expect(ingested.docId).toBeTruthy()
  })
})
