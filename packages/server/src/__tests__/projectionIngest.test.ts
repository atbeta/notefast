/**
 * 投影入方向：文件 → 库（RFC 0007 D6/D9）。
 *
 * 契约：
 *   - 新文件 → 建文档
 *   - 内容变了 → 按指纹对齐子块（保块 id；与编辑器整篇保存同一条路径）
 *   - 内容没变 → `unchanged`，不解析
 *   - 文件消失 → 文档进**回收站**（软删除），可恢复，正文不丢
 *   - 文档在回收站而文件还在 → 恢复
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeDb, getDb, initDb } from '../db'
import { fetchDocBlocks, getDocById, getLiveDocById } from '../store/blocks'
import { getProjectionFileByPath, listProjectionFiles } from '../store/projectionFiles'
import { listProjectionBlockSpans } from '../store/projectionSpans'
import { createSerialLock } from '../projection/lock'
import { ingestProjectionFile, removeProjectionFile, type ProjectionContext } from '../projection/ingest'
import { resolveProjectionConfig } from '../projection/config'

let testDir: string
let root: string
let ctx: ProjectionContext

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-proj-ingest-'))
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

/** 往投影文件夹写一个文件 */
function writeMd(rel: string, content: string): string {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf-8')
  return abs
}

function removeMd(rel: string): void {
  unlinkSync(join(root, rel))
}

describe('ingestProjectionFile：新建', () => {
  test('新文件 → 建文档，写映射与区间记录', async () => {
    writeMd('第一篇.md', '第一段\n\n第二段\n')
    const r = await ingestProjectionFile(ctx, '第一篇.md')

    expect(r.action).toBe('created')
    expect(r.docId).toBeTruthy()

    const doc = getDocById(getDb(), r.docId!)!
    expect(doc.content).toBe('第一篇')
    const children = fetchDocBlocks(getDb(), r.docId!).filter((b) => b.id !== r.docId)
    expect(children.map((b) => b.content)).toEqual(['第一段', '第二段'])

    const row = getProjectionFileByPath(getDb(), ctx.notebookId, '第一篇.md')!
    expect(row.doc_id).toBe(r.docId!)
    expect(row.content_sha256).toBeTruthy()
    // 区间记录建立后，出方向才能局部改写
    expect(listProjectionBlockSpans(getDb(), r.docId!).length).toBeGreaterThan(0)
  })

  test('非 markdown / 忽略目录 / 隐藏文件 → skipped', async () => {
    writeMd('图.png', 'not markdown')
    writeMd('.obsidian/x.md', 'x')
    writeMd('.DS_Store', 'x')
    expect((await ingestProjectionFile(ctx, '图.png')).action).toBe('skipped')
    expect((await ingestProjectionFile(ctx, '.obsidian/x.md')).action).toBe('skipped')
    expect((await ingestProjectionFile(ctx, '.DS_Store')).action).toBe('skipped')
  })

  test('隐藏目录里的笔记**会**被导入（与 vault 的分歧）', async () => {
    writeMd('.notes/私藏.md', '内容\n')
    const r = await ingestProjectionFile(ctx, '.notes/私藏.md')
    expect(r.action).toBe('created')
  })

  test('frontmatter 的 tags 被读入（库是权威，但导入时吸收一次）', async () => {
    writeMd('带标签.md', '---\ntags: [dev, 知识库]\n---\n正文\n')
    const r = await ingestProjectionFile(ctx, '带标签.md')
    expect(r.action).toBe('created')
    const doc = getDocById(getDb(), r.docId!)!
    expect(JSON.parse(doc.tags ?? '[]')).toEqual(['dev', '知识库'])
  })
})

describe('ingestProjectionFile：更新', () => {
  test('内容未变 → unchanged，不解析', async () => {
    writeMd('不变.md', '内容\n')
    await ingestProjectionFile(ctx, '不变.md')
    const again = await ingestProjectionFile(ctx, '不变.md')
    expect(again.action).toBe('unchanged')
  })

  test('改一个块 → 保块 id，只动那一个块', async () => {
    writeMd('改块.md', 'A段\n\nB段\n\nC段\n')
    const first = await ingestProjectionFile(ctx, '改块.md')
    const before = fetchDocBlocks(getDb(), first.docId!).filter((b) => b.id !== first.docId)
    expect(before.map((b) => b.content)).toEqual(['A段', 'B段', 'C段'])

    writeMd('改块.md', 'A段\n\nB段（改）\n\nC段\n')
    const second = await ingestProjectionFile(ctx, '改块.md')
    expect(second.action).toBe('updated')
    expect(second.updated).toBe(1)

    const after = fetchDocBlocks(getDb(), second.docId!).filter((b) => b.id !== second.docId)
    expect(after.map((b) => b.content)).toEqual(['A段', 'B段（改）', 'C段'])
    // 未被改的块保持同一个 id（引用 / 向量不作废）
    expect(after[0]!.id).toBe(before[0]!.id)
    expect(after[2]!.id).toBe(before[2]!.id)
  })

  test('插入与删除块', async () => {
    writeMd('增删.md', 'A\n\nB\n')
    const first = await ingestProjectionFile(ctx, '增删.md')

    writeMd('增删.md', 'A\n\n新插入\n\nB\n')
    const ins = await ingestProjectionFile(ctx, '增删.md')
    expect(ins.inserted).toBe(1)
    expect(
      fetchDocBlocks(getDb(), first.docId!).filter((b) => b.id !== first.docId).map((b) => b.content),
    ).toEqual(['A', '新插入', 'B'])

    writeMd('增删.md', 'A\n\nB\n')
    const del = await ingestProjectionFile(ctx, '增删.md')
    expect(del.deleted).toBe(1)
    expect(
      fetchDocBlocks(getDb(), first.docId!).filter((b) => b.id !== first.docId).map((b) => b.content),
    ).toEqual(['A', 'B'])
  })

  test('改名文件（换路径）按 move 处理，同一文档不新建', async () => {
    writeMd('移动前.md', '内容\n')
    const first = await ingestProjectionFile(ctx, '移动前.md')
    expect(first.action).toBe('created')

    // 用户在外部改名：watcher 的真实顺序是 unlink(旧) 然后 add(新)
    removeMd('移动前.md')
    removeProjectionFile(ctx, '移动前.md')
    writeMd('移动后.md', '内容\n')

    // 新路径出现：应按内容 + 「旧文档已在回收站」配对出移动，而不是新建
    const second = await ingestProjectionFile(ctx, '移动后.md')
    expect(second.docId).toBe(first.docId!)
    expect(second.action).toBe('moved')

    // 旧路径的映射已不在，新路径指向同一文档
    expect(getProjectionFileByPath(getDb(), ctx.notebookId, '移动前.md')).toBeNull()
    expect(getProjectionFileByPath(getDb(), ctx.notebookId, '移动后.md')!.doc_id).toBe(first.docId!)
    // 文档已从回收站恢复
    expect(getLiveDocById(getDb(), first.docId!)).not.toBeNull()
  })

  test('内容相同的两个独立文件不会互相认领', async () => {
    // 用户完全可能有两篇文本一样的笔记；移动检测不能只看内容
    writeMd('独立A.md', '一模一样的内容\n')
    const a = await ingestProjectionFile(ctx, '独立A.md')
    writeMd('独立B.md', '一模一样的内容\n')
    const b = await ingestProjectionFile(ctx, '独立B.md')

    expect(b.docId).not.toBe(a.docId!)
    expect(b.action).toBe('created')
    // 两个文件各自的映射都在
    expect(getProjectionFileByPath(getDb(), ctx.notebookId, '独立A.md')).not.toBeNull()
    expect(getProjectionFileByPath(getDb(), ctx.notebookId, '独立B.md')).not.toBeNull()
  })

  test('第三个同内容文件：不认领前两个还活着的文档', async () => {
    // 直接钉住「候选文档必须在回收站」这条守卫：A、B 都活着且文件都在磁盘上，
    // 再出现一个同内容文件时，绝不能认领它们（否则三篇笔记会被并成一篇）
    writeMd('同文A.md', '三份相同\n')
    const a = await ingestProjectionFile(ctx, '同文A.md')
    writeMd('同文B.md', '三份相同\n')
    const b = await ingestProjectionFile(ctx, '同文B.md')

    writeMd('同文C.md', '三份相同\n')
    const c = await ingestProjectionFile(ctx, '同文C.md')

    expect(c.action).toBe('created')
    expect(new Set([a.docId, b.docId, c.docId]).size).toBe(3)
    // 三篇文档都还活着，且各自映射都在
    for (const id of [a.docId!, b.docId!, c.docId!]) {
      expect(getLiveDocById(getDb(), id)).not.toBeNull()
    }
    expect(listProjectionFiles(getDb(), ctx.notebookId).filter((r) => r.rel_path.startsWith('同文')).length).toBe(3)
  })

  test('文件被移走但文档还活着（watcher 宽限窗口内）：不被同内容文件认领', async () => {
    /**
     * 这个场景单独覆盖「候选文档必须在回收站」这条守卫。
     *
     * 造法是真实的：watcher 的 unlink 有宽限窗口，文件从磁盘上消失之后、
     * `removeProjectionFile` 被调用之前，映射行还在、文档也还活着。
     * 此时若只看「文件不在磁盘上 + 内容相同」，另一个同内容文件就会把这篇文档抢走。
     *
     * 注意：上一条用例（三份同内容文件都在磁盘上）覆盖不到这条守卫——
     * 那时 on-disk 那条检查已经挡住了，两条守卫重叠。
     */
    writeMd('宽限源.md', '宽限内容\n')
    const src = await ingestProjectionFile(ctx, '宽限源.md')

    // 文件从磁盘消失，但**不**调用 removeProjectionFile（模拟宽限窗口内）
    removeMd('宽限源.md')
    expect(getLiveDocById(getDb(), src.docId!)).not.toBeNull()

    // 另一个同内容文件出现
    writeMd('宽限目标.md', '宽限内容\n')
    const other = await ingestProjectionFile(ctx, '宽限目标.md')

    // 必须新建，不能认领那篇还活着的文档
    expect(other.docId).not.toBe(src.docId!)
    expect(other.action).toBe('created')
    expect(getLiveDocById(getDb(), src.docId!)).not.toBeNull()
    expect(getProjectionFileByPath(getDb(), ctx.notebookId, '宽限源.md')!.doc_id).toBe(src.docId!)
  })

  test('更新时刷新区间记录（区间跟着新正文走）', async () => {
    writeMd('区间.md', 'A\n\nB\n')
    const r = await ingestProjectionFile(ctx, '区间.md')
    const before = listProjectionBlockSpans(getDb(), r.docId!)
    writeMd('区间.md', 'A\n\nB\n\nC\n')
    await ingestProjectionFile(ctx, '区间.md')
    const after = listProjectionBlockSpans(getDb(), r.docId!)
    expect(after.length).toBe(before.length + 1)
  })
})

describe('removeProjectionFile：文件消失 → 回收站（D9）', () => {
  test('文件删掉 → 文档进回收站，正文还在，可恢复', async () => {
    writeMd('会消失.md', '重要内容\n\n第二段\n')
    const r = await ingestProjectionFile(ctx, '会消失.md')
    const docId = r.docId!

    removeMd('会消失.md')
    const gone = removeProjectionFile(ctx, '会消失.md')
    expect(gone.action).toBe('deleted')
    expect(gone.docId).toBe(docId)

    // 不在流通（getLiveDocById 为 null），但行还在（软删除）
    expect(getLiveDocById(getDb(), docId)).toBeNull()
    expect(getDocById(getDb(), docId)).not.toBeNull()
    // 子块内容完整保留
    expect(
      fetchDocBlocks(getDb(), docId).filter((b) => b.id !== docId).map((b) => b.content),
    ).toEqual(['重要内容', '第二段'])
    // 映射行**保留**：文件可能只是被临时移走又移回来，那时必须认领原来那篇文档，
    // 而不是新建一篇（实测踩过）。只在文档被永久删除时才清。
    const kept = getProjectionFileByPath(getDb(), ctx.notebookId, '会消失.md')
    expect(kept).not.toBeNull()
    expect(kept!.doc_id).toBe(docId)
  })

  test('重复上报同一个消失事件是幂等的', async () => {
    writeMd('重复消失.md', '内容\n')
    const r = await ingestProjectionFile(ctx, '重复消失.md')
    removeMd('重复消失.md')
    expect(removeProjectionFile(ctx, '重复消失.md').action).toBe('deleted')
    // 第二次不应再软删除一遍，也不应报错
    const again = removeProjectionFile(ctx, '重复消失.md')
    expect(again.action).toBe('deleted')
    expect(again.deleted).toBe(0)
    expect(getDocById(getDb(), r.docId!)).not.toBeNull()
  })

  test('文件还在 → 文档从回收站恢复（用户没想删）', async () => {
    writeMd('会被恢复.md', '内容\n')
    const r = await ingestProjectionFile(ctx, '会被恢复.md')
    const docId = r.docId!

    // 先软删除（模拟用户在库里删了，但文件还在文件夹里）
    removeMd('会被恢复.md')
    removeProjectionFile(ctx, '会被恢复.md')
    expect(getLiveDocById(getDb(), docId)).toBeNull()

    // 文件又出现（用户从回收站 / git 恢复）
    writeMd('会被恢复.md', '内容\n')
    const again = await ingestProjectionFile(ctx, '会被恢复.md')
    expect(again.action).toBe('updated')
    expect(again.docId).toBe(docId)
    expect(getLiveDocById(getDb(), docId)).not.toBeNull()
  })

  test('无映射的文件消失 → skipped（不是我们管的）', () => {
    expect(removeProjectionFile(ctx, '从没导入过.md').action).toBe('skipped')
  })
})

describe('幂等与一致性', () => {
  test('重复导入同一文件不产生重复文档', async () => {
    writeMd('幂等.md', '内容\n')
    await ingestProjectionFile(ctx, '幂等.md')
    await ingestProjectionFile(ctx, '幂等.md')
    await ingestProjectionFile(ctx, '幂等.md')
    const rows = listProjectionFiles(getDb(), ctx.notebookId).filter((r) => r.rel_path === '幂等.md')
    expect(rows.length).toBe(1)
  })

  test('导入 → 映射行数目与文件数一致', async () => {
    writeMd('计数/a.md', 'a\n')
    writeMd('计数/b.md', 'b\n')
    await ingestProjectionFile(ctx, '计数/a.md')
    await ingestProjectionFile(ctx, '计数/b.md')
    const rels = listProjectionFiles(getDb(), ctx.notebookId).map((r) => r.rel_path)
    expect(rels).toContain('计数/a.md')
    expect(rels).toContain('计数/b.md')
  })
})
