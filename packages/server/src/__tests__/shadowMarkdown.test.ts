/**
 * Markdown 影子副本：data/markdown/<首标签|untagged>/<slug>--<id12>.md
 * 单向（改文件不写回）；图片改写为 ../../media/<sha>，不复制 blob。
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Hono } from 'hono'
import { initDb, closeDb, getDb } from '../db'
import { initAssetStore, saveAsset } from '../assets/store'
import { insertDocFromMarkdown } from '../services/docImport'
import { archiveRelPath } from '../sync/archive'
import { readTags } from '@notefast/core'
import { getDocById } from '../store/blocks'
import { publishDocChange, FLUSH_MS } from '../services/docEvents'
import {
  applyShadowConfig,
  fullSyncShadow,
  getShadowConfig,
  initShadowMarkdown,
  removeShadowDoc,
  rewriteShadowAssetRefs,
  stopShadowMarkdown,
  writeShadowDoc,
  _resetShadowMarkdownForTests,
} from '../services/shadowMarkdown'
import instanceRouter from '../api/instance'

let testDir: string
let notebookId: string
let app: Hono

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const waitFlush = () => new Promise((r) => setTimeout(r, FLUSH_MS + 150))
/** 后台 fullSync 用 setTimeout(0)，给事件循环一拍再断言 */
const waitDeferredFullSync = () => new Promise((r) => setTimeout(r, 50))

function markdownRoot(): string {
  return join(testDir, 'markdown')
}

function createDoc(title: string, markdown: string, tags?: string[]): string {
  const { docId } = insertDocFromMarkdown(getDb(), {
    notebookId,
    title,
    markdown,
    tags,
  })
  return docId
}

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-shadow-md-'))
  const result = initDb(testDir)
  notebookId = result.notebookId
  initAssetStore(testDir)
  initShadowMarkdown(testDir)
  app = new Hono()
  app.route('/api/v1/instance', instanceRouter)
})

afterAll(() => {
  stopShadowMarkdown()
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  getDb().query('DELETE FROM assets').run()
  getDb().query('DELETE FROM blocks').run()
  getDb().exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")
  rmSync(markdownRoot(), { recursive: true, force: true })
  rmSync(join(testDir, 'shadow-markdown.config.json'), { force: true })
  _resetShadowMarkdownForTests()
  initShadowMarkdown(testDir)
})

describe('rewriteShadowAssetRefs', () => {
  test('已存在的 asset 改写为 ../../media/<sha>，不带扩展名', () => {
    const { meta } = saveAsset(PNG_BYTES, 'image/png')
    const out = rewriteShadowAssetRefs(`见图 ![x](asset:${meta.id})`)
    expect(out).toBe(`见图 ![x](../../media/${meta.id})`)
  })

  test('悬空 asset 引用保持原样', () => {
    const missing = 'a'.repeat(64)
    const src = `![x](asset:${missing})`
    expect(rewriteShadowAssetRefs(src)).toBe(src)
  })
})

describe('writeShadowDoc', () => {
  test('无标签 → untagged/；有标签 → 首标签目录', () => {
    const untaggedId = createDoc('Hello World', '一段正文')
    const taggedId = createDoc('Hello World', '一段正文', ['work', 'ai'])
    const untagged = getDocById(getDb(), untaggedId)!
    const tagged = getDocById(getDb(), taggedId)!
    writeShadowDoc(untagged)
    writeShadowDoc(tagged)

    const untaggedRel = archiveRelPath('Hello World', untaggedId, [])
    const taggedRel = archiveRelPath('Hello World', taggedId, ['work', 'ai'])
    expect(untaggedRel.startsWith('untagged/')).toBe(true)
    expect(taggedRel.startsWith('work/')).toBe(true)
    expect(existsSync(join(markdownRoot(), untaggedRel))).toBe(true)
    expect(existsSync(join(markdownRoot(), taggedRel))).toBe(true)
    const body = readFileSync(join(markdownRoot(), taggedRel), 'utf-8')
    expect(body).toContain('一段正文')
    expect(body.startsWith('---\n')).toBe(true)
  })

  test('不把 media blob 复制进 markdown/', () => {
    const { meta } = saveAsset(PNG_BYTES, 'image/png')
    const id = createDoc('带图', `![x](asset:${meta.id})`)
    writeShadowDoc(getDocById(getDb(), id)!)
    expect(existsSync(join(testDir, 'media', meta.id))).toBe(true)
    expect(existsSync(join(markdownRoot(), 'media'))).toBe(false)
    const rel = archiveRelPath('带图', id, [])
    expect(readFileSync(join(markdownRoot(), rel), 'utf-8')).toContain(`../../media/${meta.id}`)
  })

  test('首标签变化 → 删除旧路径文件', () => {
    const id = createDoc('笔记', '正文')
    writeShadowDoc(getDocById(getDb(), id)!)
    const oldRel = archiveRelPath('笔记', id, [])
    expect(existsSync(join(markdownRoot(), oldRel))).toBe(true)

    getDb().query('UPDATE blocks SET tags = ? WHERE id = ?').run(JSON.stringify(['work']), id)
    const next = getDocById(getDb(), id)!
    writeShadowDoc(next)
    const newRel = archiveRelPath(next.content || 'untitled', id, readTags(next))
    expect(existsSync(join(markdownRoot(), newRel))).toBe(true)
    expect(existsSync(join(markdownRoot(), oldRel))).toBe(false)
  })

  test('removeShadowDoc 删除影子文件', () => {
    const id = createDoc('将删', '正文')
    writeShadowDoc(getDocById(getDb(), id)!)
    const rel = archiveRelPath('将删', id, [])
    expect(existsSync(join(markdownRoot(), rel))).toBe(true)
    removeShadowDoc(id)
    expect(existsSync(join(markdownRoot(), rel))).toBe(false)
  })

  test('关闭后 writeShadowDoc 不再落盘', () => {
    applyShadowConfig({ enabled: false })
    const id = createDoc('关闭时', '正文')
    writeShadowDoc(getDocById(getDb(), id)!)
    const rel = archiveRelPath('关闭时', id, [])
    expect(existsSync(join(markdownRoot(), rel))).toBe(false)
  })
})

describe('fullSyncShadow / 默认开启', () => {
  test('无配置文件时默认 enabled', () => {
    expect(getShadowConfig().enabled).toBe(true)
    expect(existsSync(join(testDir, 'shadow-markdown.config.json'))).toBe(false)
  })

  test('全量同步写出全部未删除文档并清掉陈旧文件', () => {
    const keepId = createDoc('保留', 'a')
    const dropId = createDoc('将删', 'b')
    fullSyncShadow()
    const dropRel = archiveRelPath('将删', dropId, [])
    expect(existsSync(join(markdownRoot(), dropRel))).toBe(true)

    getDb().query('UPDATE blocks SET is_deleted = 1 WHERE id = ?').run(dropId)
    fullSyncShadow()
    expect(existsSync(join(markdownRoot(), dropRel))).toBe(false)
    const keepRel = archiveRelPath('保留', keepId, [])
    expect(existsSync(join(markdownRoot(), keepRel))).toBe(true)
  })

  test('init 立即返回，现有文档稍后才写出', async () => {
    const id = createDoc('后台同步', '正文')
    const rel = archiveRelPath('后台同步', id, [])
    rmSync(markdownRoot(), { recursive: true, force: true })
    _resetShadowMarkdownForTests()
    initShadowMarkdown(testDir)
    expect(existsSync(join(markdownRoot(), rel))).toBe(false)
    await waitDeferredFullSync()
    expect(existsSync(join(markdownRoot(), rel))).toBe(true)
  })

  test('重新打开影子不阻塞 applyShadowConfig', async () => {
    applyShadowConfig({ enabled: false })
    const id = createDoc('重开', '正文')
    const rel = archiveRelPath('重开', id, [])
    applyShadowConfig({ enabled: true })
    expect(existsSync(join(markdownRoot(), rel))).toBe(false)
    await waitDeferredFullSync()
    expect(existsSync(join(markdownRoot(), rel))).toBe(true)
  })

  test('stop 取消尚未执行的全量同步', async () => {
    const id = createDoc('取消', '正文')
    const rel = archiveRelPath('取消', id, [])
    rmSync(markdownRoot(), { recursive: true, force: true })
    _resetShadowMarkdownForTests()
    initShadowMarkdown(testDir)
    stopShadowMarkdown()
    await waitDeferredFullSync()
    expect(existsSync(join(markdownRoot(), rel))).toBe(false)
  })

  test('内容未变时 fullSync 不重写文件', () => {
    const id = createDoc('稳定', '正文')
    fullSyncShadow()
    const dest = join(markdownRoot(), archiveRelPath('稳定', id, []))
    const mtime1 = statSync(dest).mtimeMs
    fullSyncShadow()
    expect(statSync(dest).mtimeMs).toBe(mtime1)
  })
})

describe('docEvents 订阅', () => {
  test('created 事件写出影子文件', async () => {
    const id = createDoc('事件创建', 'hello')
    publishDocChange(id, 'created')
    await waitFlush()
    const rel = archiveRelPath('事件创建', id, [])
    expect(existsSync(join(markdownRoot(), rel))).toBe(true)
  })

  test('deleted 事件删除影子文件', async () => {
    const id = createDoc('事件删除', 'hello')
    writeShadowDoc(getDocById(getDb(), id)!)
    const rel = archiveRelPath('事件删除', id, [])
    publishDocChange(id, 'deleted')
    await waitFlush()
    expect(existsSync(join(markdownRoot(), rel))).toBe(false)
  })
})

describe('GET/PUT /api/v1/instance', () => {
  test('返回绝对 data_dir / markdown_dir，以及默认开启的影子开关', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/instance'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data_dir: string
      markdown_dir: string
      shadow_markdown_enabled: boolean
    }
    expect(body.data_dir).toBe(resolve(testDir))
    expect(body.markdown_dir).toBe(resolve(join(testDir, 'markdown')))
    expect(body.shadow_markdown_enabled).toBe(true)
  })

  test('PUT 可关闭影子副本', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/instance', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shadow_markdown_enabled: false }),
    }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { shadow_markdown_enabled: boolean }
    expect(body.shadow_markdown_enabled).toBe(false)
    expect(getShadowConfig().enabled).toBe(false)
  })
})

// ───────────────────── 按块局部改写（P1b 出方向接线） ─────────────────────

describe('writeShadowDoc 局部改写', () => {
  /**
   * 语料含 Obsidian 语法、不规则空行与嵌套列表。
   *
   * 重要前提（实测）：**首次投影是整篇序列化，本身就有损**——`_斜体_` 会变 `*斜体*`、
   * 嵌套列表会被拍平（现行序列化器不缩进嵌套项）、连续空行被压成一个。
   * 这是既有行为，不是本次改动引入的。因此本组用例的契约是：
   * **首次投影之后，后续写回必须逐字节保留未被编辑的部分**，而不是要求首次就有损保真。
   */
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
    '尾段 ^abc123',
    '',
  ].join('\n')

  function shadowPath(docId: string): string {
    const doc = getDocById(getDb(), docId)!
    return join(markdownRoot(), archiveRelPath(doc.content || 'untitled', docId, readTags(doc)))
  }

  function paragraphId(docId: string, like: string): string {
    const row = getDb()
      .query("SELECT id FROM blocks WHERE root_id = ? AND type = 'paragraph' AND content LIKE ? ORDER BY sort")
      .get(docId, like) as { id: string } | null
    expect(row).toBeTruthy()
    return row!.id
  }

  test('首次投影有损（钉住既有行为，避免用例建立在不存在的假设上）', () => {
    const docId = createDoc('首次有损', FIXTURE)
    writeShadowDoc(getDocById(getDb(), docId)!)
    const first = readFileSync(shadowPath(docId), 'utf-8')
    // 这些是既有序列化行为，改掉它们要单独评估，不该被本组用例悄悄寄望
    expect(first).toContain('第一段 *斜体* 与 *斜体*')
    expect(first).toContain('- 列表项 A\n- 嵌套 B')
  })

  test('改一个块：其余块逐字节保留', () => {
    const docId = createDoc('局部改写', FIXTURE)
    writeShadowDoc(getDocById(getDb(), docId)!)
    const before = readFileSync(shadowPath(docId), 'utf-8')

    const tailId = paragraphId(docId, '尾段%')
    getDb()
      .query('UPDATE blocks SET content = ?, updated_at = ? WHERE id = ?')
      .run('尾段（改）', new Date().toISOString(), tailId)

    writeShadowDoc(getDocById(getDb(), docId)!)
    const after = readFileSync(shadowPath(docId), 'utf-8')

    expect(after).toContain('尾段（改）')
    expect(after).not.toContain('尾段 ^abc123')

    // 其余部分逐字节保留：把被改块替换成原文后，整份文件应当与 before 完全一致
    const restored = after.replace('尾段（改） ^abc123', '尾段 ^abc123')
    expect(restored).toBe(before)
  })

  test('连续改两次：每次都只动被改的块，第三次仍可局部化', () => {
    const docId = createDoc('连续改写', FIXTURE)
    writeShadowDoc(getDocById(getDb(), docId)!)
    const baseline = readFileSync(shadowPath(docId), 'utf-8')

    const firstId = paragraphId(docId, '第一段%')
    const tailId = paragraphId(docId, '尾段%')

    getDb().query('UPDATE blocks SET content = ? WHERE id = ?').run('第一段（改）', firstId)
    writeShadowDoc(getDocById(getDb(), docId)!)

    getDb().query('UPDATE blocks SET content = ? WHERE id = ?').run('尾段（改）', tailId)
    writeShadowDoc(getDocById(getDb(), docId)!)

    const after = readFileSync(shadowPath(docId), 'utf-8')
    expect(after).toContain('第一段（改）')
    expect(after).toContain('尾段（改）')
    // 两次改写之后，把两处替换回原文应当逐字节等于基线
    const restored = after
      .replace('第一段（改）', '第一段 *斜体* 与 *斜体*')
      .replace('尾段（改） ^abc123', '尾段 ^abc123')
    expect(restored).toBe(baseline)
  })

  test('引用块与列表在第二次写回时不被重新归一化', () => {
    const docId = createDoc('引用保真', FIXTURE)
    writeShadowDoc(getDocById(getDb(), docId)!)
    const quoteBefore = '> [!note] 提醒\n> 细节一\n>\n> 细节二'
    const listBefore = '- 列表项 A\n- 嵌套 B'
    const before = readFileSync(shadowPath(docId), 'utf-8')
    expect(before).toContain(quoteBefore)
    expect(before).toContain(listBefore)

    const tailId = paragraphId(docId, '尾段%')
    getDb().query('UPDATE blocks SET content = ? WHERE id = ?').run('尾段（改）', tailId)
    writeShadowDoc(getDocById(getDb(), docId)!)

    const after = readFileSync(shadowPath(docId), 'utf-8')
    expect(after).toContain(quoteBefore)
    expect(after).toContain(listBefore)
    expect(after).toContain('%%私密注释%%')
  })

  test('磁盘内容与 DB 序列化结果不同：局部改写保磁盘字节，整篇序列化会覆盖它们', () => {
    /**
     * 这是区分两条路径的关键场景，也是本机制存在的理由。
     *
     * 首次投影后手工把文件改成「排版与序列化结果不同」的形态（模拟用户在外部编辑器
     * 调整了排版，或历史版本写入的旧格式）。此时：
     * - 局部改写 → 未被编辑的块**复用磁盘字节** → 用户排版保留
     * - 整篇序列化 → 全部重新序列化 → 用户排版被冲掉
     *
     * 只改一个块，因此可以直接断言「另一块的磁盘形态是否幸存」。
     */
    const docId = createDoc('磁盘优先', '第一段内容\n\n第二段内容\n\n第三段内容')
    writeShadowDoc(getDocById(getDb(), docId)!)

    const p = shadowPath(docId)
    let disk = readFileSync(p, 'utf-8')
    // 把第一段改成序列化器不会产出的形态（行尾两个空格 = Markdown 硬换行）
    disk = disk.replace('第一段内容', '第一段内容  ')
    writeFileSync(p, disk, 'utf-8')
    expect(readFileSync(p, 'utf-8')).toContain('第一段内容  ')

    // 改第三个块，前两块不应被重写
    const thirdId = paragraphId(docId, '第三段内容')
    getDb().query('UPDATE blocks SET content = ? WHERE id = ?').run('第三段（改）', thirdId)
    writeShadowDoc(getDocById(getDb(), docId)!)

    const after = readFileSync(p, 'utf-8')
    expect(after).toContain('第三段（改）')
    // 关键断言：磁盘上第一段的字面排版幸存 → 走的是局部改写
    expect(after).toContain('第一段内容  ')
    expect(after).not.toContain('第一段内容\n')
  })

  test('文档在磁盘上被外部改过：退回整篇序列化，不抛错', () => {
    const docId = createDoc('外部改动', FIXTURE)
    writeShadowDoc(getDocById(getDb(), docId)!)
    const p = shadowPath(docId)
    // 外部工具把文件改成了完全不同的内容
    writeFileSync(p, '外部乱改的内容\n', 'utf-8')
    expect(() => writeShadowDoc(getDocById(getDb(), docId)!)).not.toThrow()
    const after = readFileSync(p, 'utf-8')
    // 仍是权威端内容，外部改动不会被合并进来（投影是单向的）
    expect(after).toContain('第一段')
    expect(after).not.toContain('外部乱改的内容')
  })
})

// ───────────────────── P2：路径归用户（RFC 0007 D2） ─────────────────────

describe('pathMode：路径归属', () => {
  afterEach(() => {
    // 档位是模块级配置，用例之间必须还原
    applyShadowConfig({ pathMode: 'system' })
  })

  function relOf(docId: string): string {
    const doc = getDocById(getDb(), docId)!
    return archiveRelPath(doc.content || 'untitled', docId, readTags(doc))
  }

  test('默认档位是 system（既有用户不被搬文件）', () => {
    expect(getShadowConfig().pathMode).toBe('system')
  })

  test('system 档位：标题变化仍按派生命名换路径（既有行为不变）', () => {
    const id = createDoc('原名', '正文')
    writeShadowDoc(getDocById(getDb(), id)!)
    const first = readFileSync(join(markdownRoot(), relOf(id)), 'utf-8')
    expect(first).toContain('正文')

    getDb().query('UPDATE blocks SET content = ? WHERE id = ?').run('改名', id)
    writeShadowDoc(getDocById(getDb(), id)!)
    const doc = getDocById(getDb(), id)!
    const newRel = archiveRelPath(doc.content || 'untitled', id, readTags(doc))
    expect(newRel).toContain('改名')
    expect(existsSync(join(markdownRoot(), newRel))).toBe(true)
  })

  test('user 档位：首次投影落可读文件名（不带 id 后缀）', () => {
    applyShadowConfig({ pathMode: 'user' })
    const id = createDoc('我的笔记', '正文')
    writeShadowDoc(getDocById(getDb(), id)!)

    expect(existsSync(join(markdownRoot(), '我的笔记.md'))).toBe(true)
    // 不带 12 位 id 后缀
    const entries = readdirSync(markdownRoot()).filter((f) => f.endsWith('.md'))
    expect(entries).toContain('我的笔记.md')
    expect(entries.some((f) => /--[0-9a-f]{12}\.md$/.test(f))).toBe(false)
  })

  test('user 档位：文档改名后文件路径不变（磁盘为准）', () => {
    applyShadowConfig({ pathMode: 'user' })
    const id = createDoc('原文件名', '正文')
    writeShadowDoc(getDocById(getDb(), id)!)
    expect(existsSync(join(markdownRoot(), '原文件名.md'))).toBe(true)

    // 改标题（system 档位下这会搬文件）
    getDb().query('UPDATE blocks SET content = ? WHERE id = ?').run('新标题', id)
    writeShadowDoc(getDocById(getDb(), id)!)

    // 关键断言：文件仍在原路径，未被搬到「新标题.md」
    expect(existsSync(join(markdownRoot(), '原文件名.md'))).toBe(true)
    expect(existsSync(join(markdownRoot(), '新标题.md'))).toBe(false)
    // 位置不变，但内容确实跟着库走：重复的标题行按新标题写
    // （标题是文档根不是块，所以它由整篇路径写入，不在局部改写的区间里）
    expect(readFileSync(join(markdownRoot(), '原文件名.md'), 'utf-8')).toContain('# 新标题')
  })

  test('user 档位：用户在外部改名 → 投影跟随，不覆盖、不新建', () => {
    applyShadowConfig({ pathMode: 'user' })
    const id = createDoc('用户会改名', '正文')
    writeShadowDoc(getDocById(getDb(), id)!)

    // 用户在 Finder / Obsidian 里把它改名并挪进子目录
    const from = join(markdownRoot(), '用户会改名.md')
    const toDir = join(markdownRoot(), '我的目录')
    mkdirSync(toDir, { recursive: true })
    const to = join(toDir, '用户会改名.md')
    renameSync(from, to)

    // 让 manifest 知道新路径（真实场景由入方向 watcher 做，P3 实现）
    const manifestPath = join(markdownRoot(), 'notefast-shadow.manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      files: Array<{ docId: string; filename: string }>
    }
    for (const f of manifest.files) if (f.docId === id) f.filename = '我的目录/用户会改名.md'
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')

    // 库里改一个块 → 写回应落在**新路径**
    const para = getDb()
      .query("SELECT id FROM blocks WHERE root_id = ? AND type = 'paragraph'")
      .get(id) as { id: string }
    getDb().query('UPDATE blocks SET content = ? WHERE id = ?').run('改过的正文', para.id)
    writeShadowDoc(getDocById(getDb(), id)!)

    expect(existsSync(to)).toBe(true)
    expect(existsSync(from)).toBe(false)
    expect(readFileSync(to, 'utf-8')).toContain('改过的正文')
  })

  test('user 档位：同题文档重名时追加 " (n)"，不互相覆盖', () => {
    applyShadowConfig({ pathMode: 'user' })
    const a = createDoc('同名', 'A')
    const b = createDoc('同名', 'B')
    writeShadowDoc(getDocById(getDb(), a)!)
    writeShadowDoc(getDocById(getDb(), b)!)

    expect(existsSync(join(markdownRoot(), '同名.md'))).toBe(true)
    expect(existsSync(join(markdownRoot(), '同名 (1).md'))).toBe(true)
    expect(readFileSync(join(markdownRoot(), '同名.md'), 'utf-8')).toContain('A')
    expect(readFileSync(join(markdownRoot(), '同名 (1).md'), 'utf-8')).toContain('B')
  })

  test('user 档位：文件被外部删除 → 下次投影按标题重新落默认名', () => {
    applyShadowConfig({ pathMode: 'user' })
    const id = createDoc('会被删掉', '正文')
    writeShadowDoc(getDocById(getDb(), id)!)
    const p = join(markdownRoot(), '会被删掉.md')
    unlinkSync(p)

    writeShadowDoc(getDocById(getDb(), id)!)
    // 不把路径钉死在一个已不存在的文件上
    expect(existsSync(p)).toBe(true)
  })

  test('切换档位：system → user 会重算路径', async () => {
    const id = createDoc('切换测试', '正文')
    writeShadowDoc(getDocById(getDb(), id)!)
    expect(existsSync(join(markdownRoot(), relOf(id)))).toBe(true)

    const oldRel = relOf(id)
    applyShadowConfig({ pathMode: 'user' })
    await waitDeferredFullSync()

    // system → user 走 fullSync 重算：新路径是去 id 后缀的可读名
    const entries = readdirSync(markdownRoot()).filter((f) => f.endsWith('.md'))
    expect(entries).toContain('切换测试.md')
    // 旧的派生路径已清理（带 --<id12> 后缀的那个）
    expect(entries.some((f) => f === oldRel)).toBe(false)
  })

  test('PUT /instance 可设置 pathMode 且不影响 enabled', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/instance', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shadow_path_mode: 'user' }),
    }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { shadow_path_mode: string; shadow_markdown_enabled: boolean }
    expect(body.shadow_path_mode).toBe('user')
    expect(body.shadow_markdown_enabled).toBe(true) // 未被这次调用改掉
    expect(getShadowConfig().pathMode).toBe('user')
  })

  test('GET /instance 报出当前档位', async () => {
    const res = await app.fetch(new Request('http://localhost/api/v1/instance'))
    const body = (await res.json()) as { shadow_path_mode: string }
    expect(['system', 'user']).toContain(body.shadow_path_mode)
  })
})
