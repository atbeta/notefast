/**
 * 文件夹投影的按块局部改写（P1b 机制层）。
 *
 * 这是整个投影方案的技术核心：SQLite 端只改一个块时，磁盘文件除该块所在区间外
 * 必须**逐字节不变**。这些用例只打纯函数（不建库、不起 watcher），
 * 因为它们承担的是「区间手术是否安全」这一件事，与谁权威无关。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { stripDocFrontmatter } from '@notefast/core'
import { closeDb, getDb, initDb } from '../db'
import { insertDocFromMarkdown } from '../services/docImport'
import { patchProjectionBody, patchProjectionContent, type PatchBlock } from '../projection/patch'
import { blockSubtreeHash, recordProjectionSpans, topLevelBlocks } from '../projection/spans'
import { listProjectionBlockSpans, type ProjectionBlockSpanRow } from '../store/projectionSpans'

/** 覆盖 Obsidian 语法、不规则空行与 $$ 的语料（与 vault 侧语料同源） */
const FIXTURE = [
  '第一段 *斜体* 与 _斜体_',
  '',
  '> [!note] 提醒',
  '> 细节一',
  '>',
  '> 细节二',
  '',
  '%%私密注释%%',
  '',
  '',
  '',
  '- 列表项 A',
  '  - 嵌套 B',
  '',
  '$$',
  'E = mc^2',
  '$$',
  '',
  '尾段 ^abc123',
  '',
  '![[img.png]]',
  '',
].join('\n')

/** 从 fixture 正文切出各顶层块原文 + 区间记录（模拟一次导入后的快照） */
function snapshot(body: string): { rows: ProjectionBlockSpanRow[]; texts: string[] } {
  // 顶层块以「非空行起、到下一个空行群前」为界，与 parseMdast 的行区间口径一致
  const blocks: Array<{ text: string; start: number; end: number }> = []
  let i = 0
  const lines = body.split('\n')
  let offset = 0
  while (i < lines.length) {
    if (lines[i]!.trim() === '') {
      offset += lines[i]!.length + 1
      i++
      continue
    }
    const start = offset
    let end = offset
    while (i < lines.length) {
      const line = lines[i]!
      // 空行的下一个非空行属于新块（列表续行仍算同块）
      if (line.trim() === '') {
        const next = lines[i + 1]
        if (next === undefined || next.trim() === '') break
        break
      }
      end = offset + line.length
      offset += line.length + 1
      i++
    }
    blocks.push({ text: body.slice(start, end), start, end })
    // 跳过块后的空行群
    while (i < lines.length && lines[i]!.trim() === '') {
      offset += lines[i]!.length + 1
      i++
    }
  }
  return {
    texts: blocks.map((b) => b.text),
    rows: blocks.map((b, idx) => ({
      doc_id: 'doc',
      block_id: `b${idx}`,
      start: b.start,
      end: b.end,
      content_hash: `h${idx}`,
    })),
  }
}

/**
 * 每个块的「DB 侧序列化文本」。
 *
 * **关键**：未改动块传进来的 text 故意与磁盘字节**不同**（模拟 mdast 归一化：
 * `_斜体_` → `*斜体*`、`$$` → ```math、引用前缀重排）。真实场景里 DB 序列化结果
 * 永远不等于用户文件原文，正因为如此才必须靠指纹判「改没改」、复用磁盘旧字节。
 *
 * 若测试传的是「与磁盘逐字节相同的 text」，复用路径与重写路径将无法区分，
 * 用例就会失去意义（变异测试验证过这一点）。
 */
const normalized = (text: string): string =>
  text
    .replace(/_([^_\n]+)_/g, '*$1*')
    .replace(/\$\$\n([\s\S]*?)\n\$\$/g, (_, inner) => '```math\n' + inner + '\n```')
    .replace(/^(>.*)$/gm, (l) => l.replace(/^>\s?/, '> '))

function blocksFrom(texts: string[], changed: Record<number, string> = {}): PatchBlock[] {
  return texts.map((text, i) => ({
    id: `b${i}`,
    hash: changed[i] !== undefined ? `h${i}-new` : `h${i}`,
    // 未改动块：传归一化后的文本（与磁盘不同）；改动块：传新文本
    text: changed[i] ?? normalized(text),
  }))
}

describe('patchProjectionBody：只改被编辑的块', () => {
  test('改中间一个块：其余块与接缝逐字节保留', () => {
    const { rows, texts } = snapshot(FIXTURE)
    const target = texts.findIndex((t) => t.startsWith('尾段'))
    expect(target).toBeGreaterThan(0)

    const out = patchProjectionBody({
      oldBody: FIXTURE,
      oldSpans: rows,
      blocks: blocksFrom(texts, { [target]: '尾段（改） ^abc123' }),
    })
    expect(out).not.toBeNull()

    // 未改动块复用磁盘旧字节（不是归一化后的 DB 文本）
    for (let i = 0; i < texts.length; i++) {
      if (i === target) continue
      expect(out!.body).toContain(texts[i]!)
    }
    // 归一化后的形态**不得**出现——它们只存在于 blocks[].text，不该被写进文件
    expect(out!.body).not.toContain('```math')
    expect(out!.body).not.toContain('*斜体* 与 *斜体*')
    // Obsidian 语法与不规则空行都没被归一化
    expect(out!.body).toContain('_斜体_')
    expect(out!.body).toContain('%%私密注释%%')
    expect(out!.body).toContain('$$\nE = mc^2\n$$')
    expect(out!.body).toContain('![[img.png]]')
    expect(out!.body).toContain('%%私密注释%%\n\n\n\n- 列表项 A')
    expect(out!.body).toContain('> [!note] 提醒\n> 细节一\n>\n> 细节二')
    // 被改块已更新
    expect(out!.body).toContain('尾段（改） ^abc123')
  })

  test('指纹变化 → 用 DB 文本重写该块（归一化只发生在这一个块上）', () => {
    const { rows, texts } = snapshot(FIXTURE)
    const target = texts.findIndex((t) => t.startsWith('第一段'))
    const out = patchProjectionBody({
      oldBody: FIXTURE,
      oldSpans: rows,
      blocks: texts.map((text, i) => ({
        id: `b${i}`,
        hash: i === target ? `h${i}-new` : `h${i}`,
        // 改动的块传「DB 归一化文本」，模拟用户真改了它
        text: i === target ? '*第一段* *斜体* 与 *斜体*' : normalized(text),
      })),
    })!
    // 被改块写入了 DB 文本
    expect(out.body).toContain('*第一段* *斜体* 与 *斜体*')
    // 其余块仍是磁盘原文
    expect(out.body).toContain('$$\nE = mc^2\n$$')
    expect(out.body).toContain('![[img.png]]')
  })

  test('区间记录随之刷新到新正文，且仍与块对齐', () => {
    const { rows, texts } = snapshot(FIXTURE)
    const out = patchProjectionBody({
      oldBody: FIXTURE,
      oldSpans: rows,
      blocks: blocksFrom(texts, { 0: '第一段（改）' }),
    })!
    expect(out.spans).toHaveLength(texts.length)
    for (const span of out.spans) {
      expect(out.body.slice(span.start, span.end).length).toBe(span.end - span.start)
      expect(span.end).toBeGreaterThan(span.start)
    }
    expect(out.body.slice(out.spans[0]!.start, out.spans[0]!.end)).toBe('第一段（改）')
  })

  test('没有区间记录 → 返回 null，调用方退回整篇序列化', () => {
    const { texts } = snapshot(FIXTURE)
    expect(patchProjectionBody({ oldBody: FIXTURE, oldSpans: [], blocks: blocksFrom(texts) })).toBeNull()
  })

  test('区间越界 → 返回 null（不产出坏文件）', () => {
    const { rows, texts } = snapshot(FIXTURE)
    const broken = rows.map((r, i) => (i === 0 ? { ...r, end: FIXTURE.length + 100 } : r))
    expect(patchProjectionBody({ oldBody: FIXTURE, oldSpans: broken, blocks: blocksFrom(texts) })).toBeNull()
  })

  test('区间重叠 → 返回 null', () => {
    const { rows, texts } = snapshot(FIXTURE)
    const broken = rows.map((r, i) => (i === 1 ? { ...r, start: rows[0]!.start } : r))
    expect(patchProjectionBody({ oldBody: FIXTURE, oldSpans: broken, blocks: blocksFrom(texts) })).toBeNull()
  })

  test('block_id 重复 → 返回 null', () => {
    const { rows, texts } = snapshot(FIXTURE)
    const broken = rows.map((r, i) => (i === 1 ? { ...r, block_id: rows[0]!.block_id } : r))
    expect(patchProjectionBody({ oldBody: FIXTURE, oldSpans: broken, blocks: blocksFrom(texts) })).toBeNull()
  })

  test('块全部为空 → 返回 null', () => {
    expect(patchProjectionBody({ oldBody: FIXTURE, oldSpans: [], blocks: [] })).toBeNull()
  })
})

describe('patchProjectionBody：插入与删除', () => {
  test('插入新块：其余块逐字节保留，新块接缝用 \\n\\n', () => {
    const { rows, texts } = snapshot(FIXTURE)
    const withNew: PatchBlock[] = [
      ...blocksFrom(texts.slice(0, 2)),
      { id: 'new', hash: 'new-hash', text: '插入的段落' },
      ...blocksFrom(texts.slice(2)).map((b, i) => ({ ...b, id: `b${i + 2}` })),
    ]
    const out = patchProjectionBody({ oldBody: FIXTURE, oldSpans: rows, blocks: withNew })
    expect(out).not.toBeNull()
    expect(out!.body).toContain('插入的段落')
    expect(out!.body).toContain('第一段 *斜体* 与 _斜体_')
    expect(out!.body).toContain('![[img.png]]')
    expect(out!.spans).toHaveLength(withNew.length)
  })

  test('删除块：该块消失，其余块逐字节保留', () => {
    const { rows, texts } = snapshot(FIXTURE)
    const target = texts.findIndex((t) => t.startsWith('%%私密注释%%'))
    const kept = texts.filter((_, i) => i !== target)
    const keptRows = rows.filter((_, i) => i !== target)
    const out = patchProjectionBody({
      oldBody: FIXTURE,
      oldSpans: keptRows,
      blocks: kept.map((t, i) => ({ id: `b${i}`, hash: `h${i}`, text: t })),
    })
    expect(out).not.toBeNull()
    expect(out!.body).not.toContain('%%私密注释%%')
    expect(out!.body).toContain('第一段 *斜体* 与 _斜体_')
    expect(out!.body).toContain('尾段 ^abc123')
  })
})

describe('patchProjectionContent：frontmatter 行级透传', () => {
  const WITH_FM = ['---', 'aliases: [x]', 'cssclasses: [wide]', '---', ...FIXTURE.split('\n')].join('\n')

  test('未出现在 patch 里的 frontmatter 键逐字节保留', () => {
    const { body } = stripDocFrontmatter(WITH_FM)
    const { rows, texts } = snapshot(body)
    const out = patchProjectionContent({
      diskContent: WITH_FM,
      oldSpans: rows,
      blocks: blocksFrom(texts, { 0: '第一段（改）' }),
      frontmatterPatch: {},
    })
    expect(out).not.toBeNull()
    expect(out!.content.startsWith('---\naliases: [x]\ncssclasses: [wide]\n---\n')).toBe(true)
    expect(out!.content).toContain('第一段（改）')
    expect(out!.frontmatterRaw).toBe('aliases: [x]\ncssclasses: [wide]')
  })

  test('只改 tags：其余键不动', () => {
    const { body } = stripDocFrontmatter(WITH_FM)
    const { rows, texts } = snapshot(body)
    const out = patchProjectionContent({
      diskContent: WITH_FM,
      oldSpans: rows,
      blocks: blocksFrom(texts),
      frontmatterPatch: { tags: ['dev', '知识库'] },
    })!
    expect(out.content).toContain('aliases: [x]')
    expect(out.content).toContain('cssclasses: [wide]')
    expect(out.content).toContain('  - dev')
    expect(out.content).toContain('  - 知识库')
  })

  test('无 frontmatter 且 patch 为空 → 仍无 frontmatter', () => {
    const { rows, texts } = snapshot(FIXTURE)
    const out = patchProjectionContent({
      diskContent: FIXTURE,
      oldSpans: rows,
      blocks: blocksFrom(texts),
      frontmatterPatch: {},
    })!
    expect(out.content.startsWith('---')).toBe(false)
    expect(out.frontmatterRaw).toBe('')
  })

  test('正文无法局部改写 → 返回 null', () => {
    expect(
      patchProjectionContent({
        diskContent: FIXTURE,
        oldSpans: [],
        blocks: [],
        frontmatterPatch: {},
      }),
    ).toBeNull()
  })
})

describe('blockSubtreeHash：指纹与序列化无关', () => {
  const block = (over: Partial<Parameters<typeof blockSubtreeHash>[0]> = {}) =>
    ({
      id: 'b',
      type: 'paragraph',
      content: 'x',
      properties: {},
      children: [],
      ...over,
    }) as Parameters<typeof blockSubtreeHash>[0]

  test('同内容同属性 → 同指纹；子块参与计算', () => {
    expect(blockSubtreeHash(block())).toBe(blockSubtreeHash(block()))
    const withChild = block({ children: [block({ id: 'c' })] as never })
    expect(blockSubtreeHash(withChild)).not.toBe(blockSubtreeHash(block()))
  })

  test('内容变化 → 指纹变化', () => {
    expect(blockSubtreeHash(block({ content: 'y' }))).not.toBe(blockSubtreeHash(block()))
  })

  test('properties 变化 → 指纹变化', () => {
    expect(blockSubtreeHash(block({ properties: { a: 1 } }))).not.toBe(blockSubtreeHash(block()))
  })
})

describe('recordProjectionSpans：与 DB 顶层块对齐', () => {
  let testDir: string

  beforeAll(() => {
    testDir = mkdtempSync(join('/tmp', 'notefast-proj-spans-'))
    initDb(testDir)
  })

  afterAll(() => {
    closeDb()
    rmSync(testDir, { recursive: true, force: true })
  })

  /** 建一篇文档并写入指定正文，返回 docId */
  function seedDoc(body: string): string {
    const db = getDb()
    const nb = db.query('SELECT id FROM notebooks LIMIT 1').get() as { id: string }
    const { docId } = insertDocFromMarkdown(db, {
      notebookId: nb.id,
      title: '投影测试',
      markdown: body,
    })
    return docId
  }

  test('对齐成功 → 写入区间记录，且切片等于源码', () => {
    const docId = seedDoc(FIXTURE)
    const ok = recordProjectionSpans(getDb(), docId, { body: FIXTURE })
    expect(ok).toBe(true)

    const rows = listProjectionBlockSpans(getDb(), docId)
    expect(rows.length).toBeGreaterThan(5)
    for (const row of rows) {
      // 区间必须落在正文内且非空
      expect(row.start).toBeGreaterThanOrEqual(0)
      expect(row.end).toBeGreaterThan(row.start)
      expect(row.end).toBeLessThanOrEqual(FIXTURE.length)
      expect(FIXTURE.slice(row.start, row.end).length).toBe(row.end - row.start)
    }
    // 与 DB 顶层块逐一对应
    expect(rows.map((r) => r.block_id)).toEqual(topLevelBlocks(getDb(), docId).map((b) => b.id))
  })

  test('重跑覆盖旧记录，不累积', () => {
    const docId = seedDoc(FIXTURE)
    recordProjectionSpans(getDb(), docId, { body: FIXTURE })
    const first = listProjectionBlockSpans(getDb(), docId).length
    recordProjectionSpans(getDb(), docId, { body: FIXTURE })
    expect(listProjectionBlockSpans(getDb(), docId)).toHaveLength(first)
  })

  test('正文与 DB 块数对不上 → 清空记录并返回 false（调用方退回整篇）', () => {
    const docId = seedDoc(FIXTURE)
    recordProjectionSpans(getDb(), docId, { body: FIXTURE })
    expect(listProjectionBlockSpans(getDb(), docId).length).toBeGreaterThan(0)

    // DB 里只有一篇的块，却给它一篇完全不同的正文 → 对齐失败
    const ok = recordProjectionSpans(getDb(), docId, { body: '只有一个段落' })
    expect(ok).toBe(false)
    expect(listProjectionBlockSpans(getDb(), docId)).toHaveLength(0)
  })
})
