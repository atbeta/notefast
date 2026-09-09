/**
 * vault mode（RFC 0001 / 0002 / 0003）：文件是权威，SQLite 是派生索引。
 *
 * 覆盖：路径守卫、原子写 + 乐观并发、ingest 的块 id 稳定性、删除→回收站→重现恢复、
 * rename 配对（引用不丢）、全量对账、写回回声抑制与冲突、HTTP 路由。
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { initDb, closeDb, getDb } from '../db'
import {
  fetchDocBlocks,
  getDeletedBlockById,
  getLiveDocById,
  insertBlock,
  nowTimestamp,
  softDeleteBlocks,
  updateBlock,
} from '../store/blocks'
import { insertRef, findRefByPair } from '../store/refs'
import { getVaultFileByDocId, getVaultFileByPath, getNotebookVaultBinding, listVaultFiles } from '../store/vaultFiles'
import { insertDocFromMarkdown } from '../services/docImport'
import { readTags, readDocStatus, stripDocFrontmatter } from '@notefast/core'
import { readDocAiExclude } from '../ai/aiExcludeQuery'
import { writeDocAiExclude } from '../ai/aiExclude'
import { subscribeDocChanges, FLUSH_MS, type DocChangeEvent } from '../services/docEvents'
import { listVaultBlockSpans, deleteVaultBlockSpans } from '../store/vaultSpans'
import { topLevelBlocks } from '../vault/spans'
import docsRouter from '../api/docs'
import type { VaultConfig } from '../vault/config'
import { DEFAULT_VAULT_IGNORE, loadVaultConfigFromEnv } from '../vault/config'
import { isIgnoredRelPath, normalizeRelPath, titleFromRelPath, toVaultRelPath, VaultPathError } from '../vault/paths'
import { sha256Hex, VaultConflictError, writeVaultFileAtomic } from '../vault/writer'
import { createSerialLock } from '../vault/lock'
import { ingestVaultFile, reconcileVault, removeVaultFile, type VaultContext } from '../vault/ingest'
import { createVaultQueue, startVaultWatcher } from '../vault/watcher'
import { serializeVaultDoc, startVaultWriteback } from '../vault/writeback'
import { createVaultRouter, createVaultRuntime } from '../vault'

let dataDir: string
let vaultDir: string
let notebookId: string
let ctx: VaultContext

function makeConfig(root: string, over: Partial<VaultConfig> = {}): VaultConfig {
  // usePolling：macOS 上 /tmp → /private/tmp 经符号链接，FSEvents 不投递事件；轮询在任何文件系统上都确定
  return {
    root,
    ignore: [...DEFAULT_VAULT_IGNORE],
    watch: false,
    writeback: false,
    stabilityMs: 50,
    usePolling: true,
    pollIntervalMs: 50,
    ...over,
  }
}

function writeVault(rel: string, content: string): void {
  const abs = join(vaultDir, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

function childIds(docId: string): string[] {
  return fetchDocBlocks(getDb(), docId)
    .filter((r) => r.id !== docId)
    .sort((a, b) => a.sort - b.sort)
    .map((r) => r.id)
}

function childContents(docId: string): string[] {
  return fetchDocBlocks(getDb(), docId)
    .filter((r) => r.id !== docId)
    .sort((a, b) => a.sort - b.sort)
    .map((r) => r.content)
}

const waitFor = async (pred: () => boolean, timeoutMs = 4000): Promise<void> => {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 25))
  }
}

beforeAll(() => {
  dataDir = mkdtempSync(join('/tmp', 'notefast-vault-data-'))
  vaultDir = mkdtempSync(join('/tmp', 'notefast-vault-root-'))
  notebookId = initDb(dataDir).notebookId
})

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(vaultDir, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDb()
  db.query('DELETE FROM vault_files').run()
  db.query('DELETE FROM block_refs').run()
  db.query('DELETE FROM blocks').run()
  db.exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")
  rmSync(vaultDir, { recursive: true, force: true })
  mkdirSync(vaultDir, { recursive: true })
  ctx = { db, notebookId, config: makeConfig(vaultDir), lock: createSerialLock() }
})

// ───────────────────── paths ─────────────────────

describe('vault paths', () => {
  test('相对路径归一化：去 ./、反斜杠、首尾斜杠', () => {
    expect(normalizeRelPath('./a\\b/c.md/')).toBe('a/b/c.md')
  })

  test('越界路径被拒绝（../、绝对外部路径、vault 根本身）', () => {
    expect(() => toVaultRelPath(vaultDir, '../escape.md')).toThrow(VaultPathError)
    expect(() => toVaultRelPath(vaultDir, '/etc/passwd')).toThrow(VaultPathError)
    expect(() => toVaultRelPath(vaultDir, vaultDir)).toThrow(VaultPathError)
    expect(toVaultRelPath(vaultDir, 'daily/2026-09-09.md')).toBe('daily/2026-09-09.md')
    expect(toVaultRelPath(vaultDir, join(vaultDir, 'a', 'b.md'))).toBe('a/b.md')
  })

  test('忽略规则：隐藏段、前缀整段匹配、不误伤相似名', () => {
    expect(isIgnoredRelPath('.obsidian/app.json', DEFAULT_VAULT_IGNORE)).toBe(true)
    expect(isIgnoredRelPath('notes/.trash/x.md', DEFAULT_VAULT_IGNORE)).toBe(true)
    expect(isIgnoredRelPath('node_modules/x.md', DEFAULT_VAULT_IGNORE)).toBe(true)
    expect(isIgnoredRelPath('templates/x.md', ['templates'])).toBe(true)
    expect(isIgnoredRelPath('templates-archive/x.md', ['templates'])).toBe(false)
  })

  test('标题 = 文件名去扩展名', () => {
    expect(titleFromRelPath('daily/2026-09-09.md')).toBe('2026-09-09')
    expect(titleFromRelPath('Weird.Name.MD')).toBe('Weird.Name')
  })

  test('配置：VAULT_PATH 不存在时报错，未设时返回 null', () => {
    expect(loadVaultConfigFromEnv({})).toBeNull()
    expect(() => loadVaultConfigFromEnv({ VAULT_PATH: join(vaultDir, 'nope') })).toThrow()
    const cfg = loadVaultConfigFromEnv({ VAULT_PATH: vaultDir, VAULT_IGNORE: 'templates, /drafts/' })!
    expect(cfg.root).toBe(vaultDir)
    expect(cfg.ignore).toContain('templates')
    expect(cfg.ignore).toContain('drafts')
    expect(cfg.writeback).toBe(true) // 默认开启（RFC 0001 D5）
    expect(cfg.watch).toBe(true)
    expect(cfg.usePolling).toBe(false)
    const off = loadVaultConfigFromEnv({ VAULT_PATH: vaultDir, VAULT_WRITEBACK: 'false', VAULT_USE_POLLING: 'true', VAULT_POLL_INTERVAL_MS: '250' })!
    expect(off.writeback).toBe(false)
    expect(off.usePolling).toBe(true)
    expect(off.pollIntervalMs).toBe(250)
  })
})

// ───────────────────── writer ─────────────────────

describe('vault writer', () => {
  test('tmp+rename 写入；内容相同不重写；expectedSha 不符抛冲突', async () => {
    const abs = join(vaultDir, 'w', 'note.md')
    const first = await writeVaultFileAtomic(abs, 'hello\n', { expectedSha: null })
    expect(first.unchanged).toBe(false)
    expect(readFileSync(abs, 'utf8')).toBe('hello\n')
    expect(first.sha256).toBe(sha256Hex('hello\n'))

    const again = await writeVaultFileAtomic(abs, 'hello\n', { expectedSha: first.sha256 })
    expect(again.unchanged).toBe(true)

    writeFileSync(abs, 'changed by obsidian\n')
    await expect(writeVaultFileAtomic(abs, 'from notefast\n', { expectedSha: first.sha256 })).rejects.toBeInstanceOf(
      VaultConflictError,
    )
    expect(readFileSync(abs, 'utf8')).toBe('changed by obsidian\n')

    // 期望不存在（新建）但文件已在 → 冲突
    await expect(writeVaultFileAtomic(abs, 'x\n', { expectedSha: null })).rejects.toBeInstanceOf(VaultConflictError)
    // 不带 expectedSha = 不检查
    const forced = await writeVaultFileAtomic(abs, 'forced\n')
    expect(forced.unchanged).toBe(false)
    expect(existsSync(join(vaultDir, 'w')) && readFileSync(abs, 'utf8')).toBe('forced\n')
  })
})

// ───────────────────── ingest ─────────────────────

describe('vault ingest', () => {
  test('新文件 → 新文档：标题取文件名，frontmatter tags 入库，同名 H1 被剥离', async () => {
    writeVault('projects/NoteFast.md', '---\ntags:\n  - Dev\n  - "知识库"\n---\n# NoteFast\n\n第一段。\n\n第二段。\n')
    const r = await ingestVaultFile(ctx, 'projects/NoteFast.md')
    expect(r.action).toBe('created')
    expect(r.inserted).toBe(2)
    const doc = getLiveDocById(getDb(), r.docId!)!
    expect(doc.content).toBe('NoteFast')
    expect(readTags(doc)).toEqual(['dev', '知识库'])
    expect(childContents(r.docId!)).toEqual(['第一段。', '第二段。'])

    const row = getVaultFileByPath(getDb(), notebookId, 'projects/NoteFast.md')!
    expect(row.doc_id).toBe(r.docId!)
    expect(row.doc_updated_at).toBe(doc.updated_at)
    expect(row.deleted_at).toBeNull()
  })

  test('内容未变 → unchanged（回声 / 空保存短路）', async () => {
    writeVault('a.md', 'alpha\n')
    const first = await ingestVaultFile(ctx, 'a.md')
    const second = await ingestVaultFile(ctx, 'a.md')
    expect(second.action).toBe('unchanged')
    expect(second.docId).toBe(first.docId)
  })

  test('微小编辑：块 id 全部保持，只有变动块标记 updated', async () => {
    writeVault('b.md', 'one\n\ntwo\n\nthree\n')
    const created = await ingestVaultFile(ctx, 'b.md')
    const before = childIds(created.docId!)
    expect(before).toHaveLength(3)

    writeVault('b.md', 'one\n\ntwo (edited)\n\nthree\n')
    const r = await ingestVaultFile(ctx, 'b.md')
    expect(r.action).toBe('updated')
    expect(r.docId).toBe(created.docId)
    expect(childIds(created.docId!)).toEqual(before)
    expect(r.updated).toBe(1)
    expect(r.inserted).toBe(0)
    expect(r.deleted).toBe(0)
    expect(childContents(created.docId!)[1]).toBe('two (edited)')
  })

  test('中间插入一段：旧块 id 不变，只新增一个', async () => {
    writeVault('c.md', 'one\n\ntwo\n\nthree\n')
    const created = await ingestVaultFile(ctx, 'c.md')
    const before = childIds(created.docId!)

    writeVault('c.md', 'one\n\ninserted\n\ntwo\n\nthree\n')
    const r = await ingestVaultFile(ctx, 'c.md')
    const after = childIds(created.docId!)
    expect(r.inserted).toBe(1)
    expect(r.deleted).toBe(0)
    expect(after).toHaveLength(4)
    expect([after[0], after[2], after[3]]).toEqual(before)
  })

  test('忽略目录与非 .md 文件 → skipped', async () => {
    writeVault('.obsidian/workspace.md', 'x')
    writeVault('img.png', 'x')
    expect((await ingestVaultFile(ctx, '.obsidian/workspace.md')).action).toBe('skipped')
    expect((await ingestVaultFile(ctx, 'img.png')).action).toBe('skipped')
    expect(listVaultFiles(getDb(), notebookId)).toHaveLength(0)
  })

  test('文件消失 → 文档进回收站；同路径重现 → 恢复同一文档与块 id', async () => {
    writeVault('d.md', 'keep me\n\nplease\n')
    const created = await ingestVaultFile(ctx, 'd.md')
    const ids = childIds(created.docId!)

    unlinkSync(join(vaultDir, 'd.md'))
    const removed = removeVaultFile(ctx, 'd.md')
    expect(removed.action).toBe('deleted')
    expect(getLiveDocById(getDb(), created.docId!)).toBeNull()
    expect(getDeletedBlockById(getDb(), created.docId!)).not.toBeNull()
    expect(getVaultFileByPath(getDb(), notebookId, 'd.md')!.deleted_at).not.toBeNull()

    writeVault('d.md', 'keep me\n\nplease\n')
    const back = await ingestVaultFile(ctx, 'd.md')
    expect(back.action).toBe('restored')
    expect(back.docId).toBe(created.docId)
    expect(childIds(created.docId!)).toEqual(ids)
    expect(getVaultFileByPath(getDb(), notebookId, 'd.md')!.deleted_at).toBeNull()
  })

  test('删除后同内容出现在新路径 → 按 sha 配对为 moved，文档 id 不变、标题跟随文件名', async () => {
    writeVault('old.md', 'same content\n')
    const created = await ingestVaultFile(ctx, 'old.md')
    unlinkSync(join(vaultDir, 'old.md'))
    removeVaultFile(ctx, 'old.md')

    writeVault('new-name.md', 'same content\n')
    const r = await ingestVaultFile(ctx, 'new-name.md')
    expect(r.action).toBe('moved')
    expect(r.docId).toBe(created.docId)
    expect(getLiveDocById(getDb(), created.docId!)!.content).toBe('new-name')
    expect(getVaultFileByPath(getDb(), notebookId, 'old.md')).toBeNull()
    expect(getVaultFileByPath(getDb(), notebookId, 'new-name.md')!.doc_id).toBe(created.docId!)
  })

  test('通过队列 unlink+add 配对：纯移动，引用与块 id 全部保留', async () => {
    writeVault('src.md', 'source doc\n')
    writeVault('target.md', 'target doc\n')
    const src = await ingestVaultFile(ctx, 'src.md')
    const target = await ingestVaultFile(ctx, 'target.md')
    const srcBlock = childIds(src.docId!)[0]!
    insertRef(getDb(), { sourceId: srcBlock, targetId: target.docId!, refType: 'manual' })

    renameSync(join(vaultDir, 'target.md'), join(vaultDir, 'target-2.md'))
    const q = createVaultQueue(ctx, { renameGraceMs: 300 })
    q.push('unlink', 'target.md')
    q.push('change', 'target-2.md')
    await q.idle()

    expect(getLiveDocById(getDb(), target.docId!)!.content).toBe('target-2')
    expect(getVaultFileByPath(getDb(), notebookId, 'target-2.md')!.doc_id).toBe(target.docId!)
    expect(getVaultFileByPath(getDb(), notebookId, 'target.md')).toBeNull()
    expect(findRefByPair(getDb(), srcBlock, target.docId!)).not.toBeNull()
    await q.close()
  })

  test('队列：unlink 窗口内无配对 → 到期进回收站；窗口内文件回来 → 重新 ingest', async () => {
    writeVault('gone.md', 'bye\n')
    writeVault('flicker.md', 'v1\n')
    const gone = await ingestVaultFile(ctx, 'gone.md')
    const flicker = await ingestVaultFile(ctx, 'flicker.md')

    unlinkSync(join(vaultDir, 'gone.md'))
    const q = createVaultQueue(ctx, { renameGraceMs: 100 })
    q.push('unlink', 'gone.md')
    // flicker：unlink 后编辑器立刻重建（不同内容）
    q.push('unlink', 'flicker.md')
    writeVault('flicker.md', 'v2\n')
    await q.idle()

    expect(getLiveDocById(getDb(), gone.docId!)).toBeNull()
    expect(getLiveDocById(getDb(), flicker.docId!)).not.toBeNull()
    expect(childContents(flicker.docId!)).toEqual(['v2'])
    await q.close()
  })

  test('全量对账：新建 / 更新 / 移动 / 删除 一次到位', async () => {
    writeVault('a.md', 'A\n')
    writeVault('sub/b.md', 'B\n')
    writeVault('c.md', 'C\n')
    const first = await reconcileVault(ctx)
    expect(first.totalFiles).toBe(3)
    expect(first.created).toBe(3)
    const bId = getVaultFileByPath(getDb(), notebookId, 'sub/b.md')!.doc_id

    unlinkSync(join(vaultDir, 'a.md'))
    renameSync(join(vaultDir, 'sub', 'b.md'), join(vaultDir, 'b-moved.md'))
    writeVault('c.md', 'C changed\n')
    const second = await reconcileVault(ctx)
    expect(second.moved).toBe(1)
    expect(second.updated).toBe(1)
    expect(second.deleted).toBe(1)
    expect(second.unchanged).toBe(1)
    expect(second.created).toBe(0)
    expect(getVaultFileByPath(getDb(), notebookId, 'b-moved.md')!.doc_id).toBe(bId)
    expect(getVaultFileByPath(getDb(), notebookId, 'a.md')!.deleted_at).not.toBeNull()
    expect(second.errors).toEqual([])
  })
})

// ───────────────────── watcher（真实 fs）─────────────────────

describe('vault watcher', () => {
  test('写文件 → 自动 ingest；删文件 → 回收站', async () => {
    const results: string[] = []
    const watcher = await startVaultWatcher(ctx, { renameGraceMs: 150, onResult: (r) => results.push(`${r.action}:${r.relPath}`) })
    try {
      writeVault('live.md', 'watched\n')
      await waitFor(() => Boolean(getVaultFileByPath(getDb(), notebookId, 'live.md')))
      const docId = getVaultFileByPath(getDb(), notebookId, 'live.md')!.doc_id
      expect(getLiveDocById(getDb(), docId)!.content).toBe('live')

      unlinkSync(join(vaultDir, 'live.md'))
      await waitFor(() => getLiveDocById(getDb(), docId) === null)
      expect(results).toContain('created:live.md')
    } finally {
      await watcher.close()
    }
  })
})

// ───────────────────── writeback ─────────────────────

describe('vault writeback', () => {
  test('序列化：无 `# title`，仅有标签时带 Obsidian 兼容 frontmatter', async () => {
    writeVault('s.md', '---\ntags:\n  - x\n---\nbody line\n\n## Section\n\nmore\n')
    const r = await ingestVaultFile(ctx, 's.md')
    const doc = getLiveDocById(getDb(), r.docId!)!
    const row = getVaultFileByPath(getDb(), notebookId, 's.md')!
    const out = serializeVaultDoc(ctx, doc, row)
    expect(out.startsWith('---\ntags:\n  - x\n---\n')).toBe(true)
    expect(out).not.toContain('# s\n')
    expect(out).toContain('## Section')
  })

  // ── V-201 frontmatter 透传（RFC 0003 阶段 B）──

  test('V-201 用户手写 frontmatter 逐字节保留，写回只动被编辑的块', async () => {
    const original = [
      '---',
      'aliases:',
      '  - NF',
      'cssclasses: [wide, dark]',
      'custom_key: keep me',
      'tags:',
      '  - dev',
      '---',
      'para one',
      '',
      'para two',
      '',
    ].join('\n')
    writeVault('fm.md', original)
    const r = await ingestVaultFile(ctx, 'fm.md')
    expect(getVaultFileByPath(getDb(), notebookId, 'fm.md')!.frontmatter_raw).toBe(
      'aliases:\n  - NF\ncssclasses: [wide, dark]\ncustom_key: keep me\ntags:\n  - dev\n',
    )

    updateBlock(getDb(), childIds(r.docId!)[1]!, { content: 'para two (ai)', actor: 'mcp' })
    const wb = startVaultWriteback(ctx)
    try {
      expect((await wb.handle({ doc_id: r.docId!, kind: 'updated', at: new Date().toISOString() })).kind).toBe('written')
    } finally {
      wb.stop()
    }
    expect(readFileSync(join(vaultDir, 'fm.md'), 'utf8')).toBe(original.replace('para two\n', 'para two (ai)\n'))
  })

  test('V-201 内联 tags 写法可入库，写回统一为块列表', async () => {
    writeVault('inline.md', '---\ntags: [Dev, 知识库]\n---\nbody\n')
    const r = await ingestVaultFile(ctx, 'inline.md')
    expect(readTags(getLiveDocById(getDb(), r.docId!)!)).toEqual(['dev', '知识库'])

    updateBlock(getDb(), r.docId!, { tags: JSON.stringify(['dev', '知识库', 'new']) })
    updateBlock(getDb(), childIds(r.docId!)[0]!, { content: 'body (ai)', actor: 'mcp' })
    const wb = startVaultWriteback(ctx)
    try {
      expect((await wb.handle({ doc_id: r.docId!, kind: 'updated', at: new Date().toISOString() })).kind).toBe('written')
    } finally {
      wb.stop()
    }
    expect(readFileSync(join(vaultDir, 'inline.md'), 'utf8')).toBe(
      '---\ntags:\n  - dev\n  - 知识库\n  - new\n---\nbody (ai)\n',
    )
  })

  test('V-201 清空标签 → 只删 tags 键，其余 frontmatter 原样保留', async () => {
    writeVault('untag.md', '---\naliases:\n  - NF\ntags:\n  - dev\n---\nbody\n')
    const r = await ingestVaultFile(ctx, 'untag.md')

    updateBlock(getDb(), r.docId!, { tags: JSON.stringify([]) })
    updateBlock(getDb(), childIds(r.docId!)[0]!, { content: 'body (ai)', actor: 'mcp' })
    const wb = startVaultWriteback(ctx)
    try {
      expect((await wb.handle({ doc_id: r.docId!, kind: 'updated', at: new Date().toISOString() })).kind).toBe('written')
    } finally {
      wb.stop()
    }
    expect(readFileSync(join(vaultDir, 'untag.md'), 'utf8')).toBe('---\naliases:\n  - NF\n---\nbody (ai)\n')
  })

  test('V-201 无 frontmatter 且无标签 → 写回后仍无 frontmatter', async () => {
    writeVault('bare.md', 'plain one\n\nplain two\n')
    const r = await ingestVaultFile(ctx, 'bare.md')
    expect(getVaultFileByPath(getDb(), notebookId, 'bare.md')!.frontmatter_raw).toBeNull()

    updateBlock(getDb(), childIds(r.docId!)[1]!, { content: 'plain two (ai)', actor: 'mcp' })
    const wb = startVaultWriteback(ctx)
    try {
      expect((await wb.handle({ doc_id: r.docId!, kind: 'updated', at: new Date().toISOString() })).kind).toBe('written')
    } finally {
      wb.stop()
    }
    expect(readFileSync(join(vaultDir, 'bare.md'), 'utf8')).toBe('plain one\n\nplain two (ai)\n')
  })

  test('ingest 回声不写盘；SQLite 端编辑写回；外部改动触发冲突不覆盖', async () => {
    writeVault('wb.md', 'para one\n\npara two\n')
    const r = await ingestVaultFile(ctx, 'wb.md')
    const wb = startVaultWriteback(ctx)
    try {
      const echo = await wb.handle({ doc_id: r.docId!, kind: 'updated', at: new Date().toISOString() })
      expect(echo).toEqual({ kind: 'skipped', reason: 'echo' })
      expect(readFileSync(join(vaultDir, 'wb.md'), 'utf8')).toBe('para one\n\npara two\n')

      // NoteFast 端（AI / MCP）改一个块
      await new Promise((res) => setTimeout(res, 5))
      const secondId = childIds(r.docId!)[1]!
      updateBlock(getDb(), secondId, { content: 'para two (ai)', actor: 'mcp' })
      const written = await wb.handle({ doc_id: r.docId!, kind: 'updated', at: new Date().toISOString() })
      expect(written.kind).toBe('written')
      expect(readFileSync(join(vaultDir, 'wb.md'), 'utf8')).toBe('para one\n\npara two (ai)\n')
      // 写回后映射 sha 已对齐：紧随的 watcher 事件是 no-op
      expect((await ingestVaultFile(ctx, 'wb.md')).action).toBe('unchanged')

      // 外部工具先改了文件，NoteFast 端又改 → 拒绝覆盖
      writeFileSync(join(vaultDir, 'wb.md'), 'obsidian wins\n')
      await new Promise((res) => setTimeout(res, 5))
      updateBlock(getDb(), secondId, { content: 'para two (ai again)', actor: 'mcp' })
      const conflict = await wb.handle({ doc_id: r.docId!, kind: 'updated', at: new Date().toISOString() })
      expect(conflict.kind).toBe('conflict')
      expect(readFileSync(join(vaultDir, 'wb.md'), 'utf8')).toBe('obsidian wins\n')
    } finally {
      wb.stop()
    }
  })

  test('NoteFast 内新建文档 → 按标题落盘并建立映射；删除 → 移入 .trash', async () => {
    const wb = startVaultWriteback(ctx)
    try {
      const { docId } = insertDocFromMarkdown(getDb(), { notebookId, title: 'AI: 会议/纪要', markdown: 'hello from mcp\n' })
      const out = await wb.handle({ doc_id: docId, kind: 'created', at: new Date().toISOString() })
      expect(out.kind).toBe('written')
      const rel = (out as { relPath: string }).relPath
      expect(rel).toBe('AI 会议 纪要.md')
      expect(readFileSync(join(vaultDir, rel), 'utf8')).toBe('hello from mcp\n')
      expect(getVaultFileByDocId(getDb(), docId)!.rel_path).toBe(rel)

      // 同名再来一篇 → (2)
      const { docId: dup } = insertDocFromMarkdown(getDb(), { notebookId, title: 'AI: 会议/纪要', markdown: 'second\n' })
      const out2 = await wb.handle({ doc_id: dup, kind: 'created', at: new Date().toISOString() })
      expect((out2 as { relPath: string }).relPath).toBe('AI 会议 纪要 (2).md')

      const trashed = await wb.handle({ doc_id: docId, kind: 'deleted', at: new Date().toISOString() })
      expect(trashed.kind).toBe('trashed')
      expect(existsSync(join(vaultDir, rel))).toBe(false)
      expect(existsSync(join(vaultDir, '.trash', rel))).toBe(true)
      expect(getVaultFileByDocId(getDb(), docId)!.deleted_at).not.toBeNull()
    } finally {
      wb.stop()
    }
  })
})

// ───────────────────── 元数据双向（V-202） ─────────────────────

describe('vault metadata', () => {
  const ev = (docId: string): DocChangeEvent => ({ doc_id: docId, kind: 'updated', at: new Date().toISOString() })

  test('文件声明 notefast_ai_exclude / notefast_status → ingest 生效；改回缺省 → 复位', async () => {
    writeVault('meta.md', '---\nnotefast_ai_exclude: true\nnotefast_status: inbox\n---\nbody\n')
    const r = await ingestVaultFile(ctx, 'meta.md')
    expect(readDocAiExclude(r.docId!)).toBe(true)
    expect(readDocStatus(getLiveDocById(getDb(), r.docId!)!)).toBe('inbox')

    writeVault('meta.md', '---\nnotefast_ai_exclude: false\nnotefast_status: note\n---\nbody\n')
    expect((await ingestVaultFile(ctx, 'meta.md')).action).toBe('updated')
    expect(readDocAiExclude(r.docId!)).toBe(false)
    expect(readDocStatus(getLiveDocById(getDb(), r.docId!)!)).toBe('note')
  })

  test('NoteFast 侧切 ai_exclude / status → 写回文件；切回缺省 → 键被删除', async () => {
    writeVault('flip.md', 'body\n')
    const r = await ingestVaultFile(ctx, 'flip.md')
    const wb = startVaultWriteback(ctx)
    try {
      // ai_exclude 走 touchUpdatedAt:false：updated_at 不变，只有 meta_hash 能识别出真实变更
      writeDocAiExclude(r.docId!, true)
      expect(await wb.handle(ev(r.docId!))).toMatchObject({ kind: 'written' })
      expect(readFileSync(join(vaultDir, 'flip.md'), 'utf8')).toBe('---\nnotefast_ai_exclude: true\n---\nbody\n')

      updateBlock(getDb(), r.docId!, { status: 'inbox' })
      expect(await wb.handle(ev(r.docId!))).toMatchObject({ kind: 'written' })
      expect(readFileSync(join(vaultDir, 'flip.md'), 'utf8')).toBe(
        '---\nnotefast_ai_exclude: true\nnotefast_status: inbox\n---\nbody\n',
      )

      // 两键都切回缺省 → 键被删除，文件回到无 frontmatter
      writeDocAiExclude(r.docId!, false)
      updateBlock(getDb(), r.docId!, { status: 'note' })
      expect(await wb.handle(ev(r.docId!))).toMatchObject({ kind: 'written' })
      expect(readFileSync(join(vaultDir, 'flip.md'), 'utf8')).toBe('body\n')
    } finally {
      wb.stop()
    }
  })

  test('只改标签（touchUpdatedAt:false）也会写回；写回后纯回声不再写盘', async () => {
    writeVault('tag.md', 'body\n')
    const r = await ingestVaultFile(ctx, 'tag.md')
    const wb = startVaultWriteback(ctx)
    try {
      updateBlock(getDb(), r.docId!, { tags: JSON.stringify(['dev']), touchUpdatedAt: false })
      expect(await wb.handle(ev(r.docId!))).toMatchObject({ kind: 'written' })
      expect(readFileSync(join(vaultDir, 'tag.md'), 'utf8')).toBe('---\ntags:\n  - dev\n---\nbody\n')
      expect(await wb.handle(ev(r.docId!))).toEqual({ kind: 'skipped', reason: 'echo' })
    } finally {
      wb.stop()
    }
  })

  test('纯回声：文件里带元数据的文档 ingest 后立刻 handle → skipped/echo', async () => {
    writeVault('echo2.md', '---\nnotefast_ai_exclude: true\n---\nbody\n')
    const r = await ingestVaultFile(ctx, 'echo2.md')
    const wb = startVaultWriteback(ctx)
    try {
      expect(await wb.handle(ev(r.docId!))).toEqual({ kind: 'skipped', reason: 'echo' })
    } finally {
      wb.stop()
    }
  })

  test('归档文档：文件没写该键时不降级为 note，写回也不写该键', async () => {
    writeVault('arch.md', 'body\n')
    const r = await ingestVaultFile(ctx, 'arch.md')
    updateBlock(getDb(), r.docId!, { status: 'archived' })

    writeVault('arch.md', 'body edited\n')
    expect((await ingestVaultFile(ctx, 'arch.md')).action).toBe('updated')
    expect(readDocStatus(getLiveDocById(getDb(), r.docId!)!)).toBe('archived')

    const row = getVaultFileByPath(getDb(), notebookId, 'arch.md')!
    expect(serializeVaultDoc(ctx, getLiveDocById(getDb(), r.docId!)!, row)).toBe('body edited\n')
  })

  test('PATCH /docs/:id/ai_exclude 发 doc 级事件（vault 写回据此触发）', async () => {
    const app = new Hono()
    app.route('/api/v1/docs', docsRouter)
    writeVault('evt.md', 'body\n')
    const r = await ingestVaultFile(ctx, 'evt.md')
    // 先让 ingest 的 created 事件 flush 掉，再订阅，避免把上一步的事件混进来
    await new Promise((res) => setTimeout(res, FLUSH_MS + 50))

    const seen: DocChangeEvent[] = []
    const unsub = subscribeDocChanges((e) => {
      if (e.doc_id === r.docId) seen.push(e)
    })
    try {
      const res = await app.request(`/api/v1/docs/${r.docId}/ai-exclude`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ai_exclude: true }),
      })
      expect(res.status).toBe(200)
      await waitFor(() => seen.length > 0, 2000)
      expect(seen[0]!.kind).toBe('updated')
    } finally {
      unsub()
    }
  })
})

// ───────────────────── 按块局部写回（V-203） ─────────────────────

describe('vault block patch', () => {
  const FIXTURE = [
    '---',
    'aliases: [x]',
    '---',
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

  const ev = (docId: string): DocChangeEvent => ({ doc_id: docId, kind: 'updated', at: new Date().toISOString() })
  const fullWriteCount = (): number =>
    (getDb().query(`SELECT count(*) AS c FROM app_logs WHERE message = 'doc.vault_written_full'`).get() as {
      c: number
    }).c

  /** 文件里 frontmatter 前缀长度（区间记录是 body 相对偏移） */
  function bodyPrefix(content: string): number {
    return content.length - stripDocFrontmatter(content).body.length
  }

  function spanTexts(docId: string, content: string): string[] {
    const prefix = bodyPrefix(content)
    return listVaultBlockSpans(getDb(), docId).map((s) => content.slice(prefix + s.start, prefix + s.end))
  }

  test('改一个块：其余块逐字节保留（callout / %% / ^id / 嵌入 / 不规则空行 / $$）', async () => {
    writeVault('patch.md', FIXTURE)
    const r = await ingestVaultFile(ctx, 'patch.md')
    expect(readFileSync(join(vaultDir, 'patch.md'), 'utf8')).toBe(FIXTURE)

    const spansBefore = listVaultBlockSpans(getDb(), r.docId!)
    expect(spansBefore.length).toBeGreaterThan(5)
    const before = FIXTURE
    const prefix = bodyPrefix(before)
    const tail = topLevelBlocks(getDb(), r.docId!).find((b) => b.content.startsWith('尾段'))!
    const fullBefore = fullWriteCount()

    updateBlock(getDb(), tail.id, { content: '尾段（改） ^abc123', actor: 'mcp' })
    const wb = startVaultWriteback(ctx)
    try {
      expect(await wb.handle(ev(r.docId!))).toMatchObject({ kind: 'written' })
    } finally {
      wb.stop()
    }

    const after = readFileSync(join(vaultDir, 'patch.md'), 'utf8')
    // 未改动块的字节原样保留
    for (const s of spansBefore) {
      if (s.block_id === tail.id) continue
      expect(after).toContain(before.slice(prefix + s.start, prefix + s.end))
    }
    // Obsidian 语法不被归一化、空行与接缝原样
    expect(after).toContain('_斜体_')
    expect(after).toContain('%%私密注释%%')
    expect(after).toContain('$$\nE = mc^2\n$$')
    expect(after).toContain('![[img.png]]')
    expect(after).toContain('%%私密注释%%\n\n\n\n- 列表项 A')
    expect(after).toContain('> [!note] 提醒\n> 细节一\n>\n> 细节二')
    // 被改块已更新，frontmatter 仍透传
    expect(after).toContain('尾段（改） ^abc123')
    expect(after.startsWith('---\naliases: [x]\n---\n')).toBe(true)
    // 走的是局部改写，不是整篇序列化
    expect(fullWriteCount()).toBe(fullBefore)

    // 区间记录已刷新到新正文
    const spansAfter = listVaultBlockSpans(getDb(), r.docId!)
    expect(spansAfter).toHaveLength(spansBefore.length)
    expect(spanTexts(r.docId!, after)).toContain('尾段（改） ^abc123')
  })

  test('插入新块：只追加新块，其余块逐字节保留', async () => {
    writeVault('insert.md', FIXTURE)
    const r = await ingestVaultFile(ctx, 'insert.md')
    const spansBefore = listVaultBlockSpans(getDb(), r.docId!)
    const prefix = bodyPrefix(FIXTURE)
    const tops = topLevelBlocks(getDb(), r.docId!)

    insertBlock(getDb(), {
      id: crypto.randomUUID(),
      notebook_id: notebookId,
      parent_id: r.docId!,
      root_id: r.docId!,
      type: 'paragraph',
      content: '新增段落',
      properties: '{}',
      sort: tops[tops.length - 1]!.sort + 1,
      level: 1,
      now: nowTimestamp(),
    })

    const wb = startVaultWriteback(ctx)
    try {
      expect(await wb.handle(ev(r.docId!))).toMatchObject({ kind: 'written' })
    } finally {
      wb.stop()
    }

    const after = readFileSync(join(vaultDir, 'insert.md'), 'utf8')
    expect(after.endsWith('新增段落\n')).toBe(true)
    for (const s of spansBefore) {
      expect(after).toContain(FIXTURE.slice(prefix + s.start, prefix + s.end))
    }
    expect(after).toContain('![[img.png]]\n\n新增段落\n')
  })

  test('删除块：只去掉该块，其余块逐字节保留', async () => {
    writeVault('del.md', FIXTURE)
    const r = await ingestVaultFile(ctx, 'del.md')
    const spansBefore = listVaultBlockSpans(getDb(), r.docId!)
    const prefix = bodyPrefix(FIXTURE)
    const victim = topLevelBlocks(getDb(), r.docId!).find((b) => b.content.includes('私密注释'))!

    softDeleteBlocks(getDb(), [victim.id])

    const wb = startVaultWriteback(ctx)
    try {
      expect(await wb.handle(ev(r.docId!))).toMatchObject({ kind: 'written' })
    } finally {
      wb.stop()
    }

    const after = readFileSync(join(vaultDir, 'del.md'), 'utf8')
    expect(after).not.toContain('私密注释')
    for (const s of spansBefore) {
      if (s.block_id === victim.id) continue
      expect(after).toContain(FIXTURE.slice(prefix + s.start, prefix + s.end))
    }
  })

  test('嵌套子块被改 → 归到其顶层祖先重写，其他块仍逐字节保留', async () => {
    writeVault('nested.md', FIXTURE)
    const r = await ingestVaultFile(ctx, 'nested.md')
    const spansBefore = listVaultBlockSpans(getDb(), r.docId!)
    const prefix = bodyPrefix(FIXTURE)
    const nested = fetchDocBlocks(getDb(), r.docId!).find((b) => b.content === '嵌套 B')!

    updateBlock(getDb(), nested.id, { content: '嵌套 B（改）', actor: 'mcp' })

    const wb = startVaultWriteback(ctx)
    try {
      expect(await wb.handle(ev(r.docId!))).toMatchObject({ kind: 'written' })
    } finally {
      wb.stop()
    }

    const after = readFileSync(join(vaultDir, 'nested.md'), 'utf8')
    expect(after).toContain('嵌套 B（改）')
    for (const s of spansBefore) {
      // 列表块整体重写（现行序列化器不缩进嵌套项，见语料 21-nested-list），其余块逐字节保留
      if (s.block_id === nested.parent_id) continue
      expect(after).toContain(FIXTURE.slice(prefix + s.start, prefix + s.end))
    }
  })

  test('区间记录缺失 → 退回整篇序列化并记审计 doc.vault_written_full', async () => {
    const simple = ['---', 'aliases: [x]', '---', '第一段 _斜体_', '', '第二段', '', '第三段', ''].join('\n')
    writeVault('fallback.md', simple)
    const r = await ingestVaultFile(ctx, 'fallback.md')
    deleteVaultBlockSpans(getDb(), r.docId!)
    const tail = topLevelBlocks(getDb(), r.docId!).find((b) => b.content === '第三段')!
    const fullBefore = fullWriteCount()

    updateBlock(getDb(), tail.id, { content: '第三段（改）', actor: 'mcp' })
    const wb = startVaultWriteback(ctx)
    try {
      expect(await wb.handle(ev(r.docId!))).toMatchObject({ kind: 'written' })
    } finally {
      wb.stop()
    }

    const after = readFileSync(join(vaultDir, 'fallback.md'), 'utf8')
    // 整篇序列化会归一化 `_斜体_`（局部改写不会）
    expect(after).toContain('*斜体*')
    expect(after).not.toContain('_斜体_')
    expect(after).toContain('第三段（改）')
    expect(fullWriteCount()).toBe(fullBefore + 1)
    // 退回整篇后重新记录区间，下一次仍能局部改写
    expect(listVaultBlockSpans(getDb(), r.docId!).length).toBeGreaterThan(0)
  })

  test('区间越界 → 退回整篇序列化（不按坏区间改文件）', async () => {
    const simple = ['第一段 _斜体_', '', '第二段', '', '第三段', ''].join('\n')
    writeVault('oob.md', simple)
    const r = await ingestVaultFile(ctx, 'oob.md')
    getDb().query('UPDATE vault_block_spans SET end = 999999 WHERE doc_id = ?').run(r.docId!)
    const tail = topLevelBlocks(getDb(), r.docId!).find((b) => b.content === '第三段')!
    const fullBefore = fullWriteCount()

    updateBlock(getDb(), tail.id, { content: '第三段（改）', actor: 'mcp' })
    const wb = startVaultWriteback(ctx)
    try {
      expect(await wb.handle(ev(r.docId!))).toMatchObject({ kind: 'written' })
    } finally {
      wb.stop()
    }
    expect(readFileSync(join(vaultDir, 'oob.md'), 'utf8')).toContain('第三段（改）')
    expect(fullWriteCount()).toBe(fullBefore + 1)
  })

  test('整篇退回后含嵌套列表的文档无法重建区间 → 继续安全退回，不产生重复块', async () => {
    writeVault('flat.md', FIXTURE)
    const r = await ingestVaultFile(ctx, 'flat.md')
    deleteVaultBlockSpans(getDb(), r.docId!)
    const tail = topLevelBlocks(getDb(), r.docId!).find((b) => b.content.startsWith('尾段'))!

    updateBlock(getDb(), tail.id, { content: '尾段（改） ^abc123', actor: 'mcp' })
    const wb = startVaultWriteback(ctx)
    try {
      expect(await wb.handle(ev(r.docId!))).toMatchObject({ kind: 'written' })
      // 现行序列化器把嵌套列表拍平（语料 21-nested-list 冻结），重解析块数与 DB 不符 → 区间清空
      expect(listVaultBlockSpans(getDb(), r.docId!)).toHaveLength(0)
      // 第二次写回同样退回整篇：内容稳定，不出现重复块
      const again = readFileSync(join(vaultDir, 'flat.md'), 'utf8')
      expect(await wb.handle(ev(r.docId!))).toMatchObject({ kind: 'skipped', reason: 'echo' })
      expect(readFileSync(join(vaultDir, 'flat.md'), 'utf8')).toBe(again)
    } finally {
      wb.stop()
    }
  })
})

// ───────────────────── 冲突副本（V-204） ─────────────────────

describe('vault conflict copy', () => {
  test('写回冲突 → 原文件不动、NoteFast 版本另存副本，status.conflicts 可查', async () => {
    writeVault('c.md', 'para one\n\npara two\n')
    const r = await ingestVaultFile(ctx, 'c.md')
    const wb = startVaultWriteback(ctx)
    try {
      // 外部工具（Obsidian）先改了文件
      writeFileSync(join(vaultDir, 'c.md'), 'obsidian wins\n')
      await new Promise((res) => setTimeout(res, 5))
      updateBlock(getDb(), childIds(r.docId!)[1]!, { content: 'para two (ai)', actor: 'mcp' })

      const out = await wb.handle({ doc_id: r.docId!, kind: 'updated', at: new Date().toISOString() })
      expect(out.kind).toBe('conflict')

      // 原文件保持用户版本，不覆盖
      expect(readFileSync(join(vaultDir, 'c.md'), 'utf8')).toBe('obsidian wins\n')

      // 副本存在且内容是 NoteFast 版本
      const copies = readdirSync(vaultDir).filter((f) => f.startsWith('c.notefast-conflict-'))
      expect(copies).toHaveLength(1)
      expect(copies[0]).toMatch(/^c\.notefast-conflict-\d{8}-\d{6}\.md$/)
      expect(readFileSync(join(vaultDir, copies[0]!), 'utf8')).toBe('para one\n\npara two (ai)\n')

      // status.conflicts：24h 计数 + 最近路径
      const status = createVaultRuntime({ db: getDb(), notebookId, config: makeConfig(vaultDir) }).status()
      expect(status.conflicts.count).toBeGreaterThanOrEqual(1)
      expect(status.conflicts.paths[0]).toBe(copies[0])

      // 副本是普通 vault 文件：会被 ingest 成新文档（用户可见，自行合并）
      expect((await ingestVaultFile(ctx, copies[0]!)).action).toBe('created')
    } finally {
      wb.stop()
    }
  })

  test('同秒多次冲突不覆盖已有副本', async () => {
    writeVault('dup.md', 'one\n')
    const r = await ingestVaultFile(ctx, 'dup.md')
    const wb = startVaultWriteback(ctx)
    try {
      writeFileSync(join(vaultDir, 'dup.md'), 'external A\n')
      await new Promise((res) => setTimeout(res, 5))
      updateBlock(getDb(), r.docId!, { content: 'dup', actor: 'mcp' })
      updateBlock(getDb(), childIds(r.docId!)[0]!, { content: 'one (ai)', actor: 'mcp' })
      expect((await wb.handle({ doc_id: r.docId!, kind: 'updated', at: new Date().toISOString() })).kind).toBe(
        'conflict',
      )

      writeFileSync(join(vaultDir, 'dup.md'), 'external B\n')
      await new Promise((res) => setTimeout(res, 5))
      updateBlock(getDb(), childIds(r.docId!)[0]!, { content: 'one (ai again)', actor: 'mcp' })
      expect((await wb.handle({ doc_id: r.docId!, kind: 'updated', at: new Date().toISOString() })).kind).toBe(
        'conflict',
      )

      const copies = readdirSync(vaultDir).filter((f) => f.startsWith('dup.notefast-conflict-'))
      expect(copies).toHaveLength(2)
      expect(readFileSync(join(vaultDir, 'dup.md'), 'utf8')).toBe('external B\n')
    } finally {
      wb.stop()
    }
  })
})

// ───────────────────── runtime + routes ─────────────────────

describe('vault runtime & routes', () => {
  test('未启用 → status.enabled=false，其余端点 404', async () => {
    const app = new Hono()
    app.route('/api/v1/vault', createVaultRouter(() => null))
    expect(await (await app.request('/api/v1/vault/status')).json()).toEqual({ enabled: false })
    expect((await app.request('/api/v1/vault/rebuild', { method: 'POST' })).status).toBe(404)
  })

  test('启动：绑定 notebook、对账、状态；ingest 越界路径 400', async () => {
    writeVault('r1.md', 'one\n')
    writeVault('r2.md', 'two\n')
    const runtime = createVaultRuntime({ db: getDb(), notebookId, config: makeConfig(vaultDir) })
    await runtime.start({ awaitReconcile: true })
    try {
      const binding = getNotebookVaultBinding(getDb(), notebookId)!
      expect(binding.kind).toBe('vault')
      expect(binding.vault_root).toBe(vaultDir)

      const app = new Hono()
      app.route('/api/v1/vault', createVaultRouter(() => runtime))
      const status = (await (await app.request('/api/v1/vault/status')).json()) as Record<string, unknown>
      expect(status.enabled).toBe(true)
      expect(status.files).toBe(2)
      expect(status.watcher_active).toBe(false)
      expect((status.last_reconcile as { created: number }).created).toBe(2)

      const bad = await app.request('/api/v1/vault/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '../outside.md' }),
      })
      expect(bad.status).toBe(400)

      writeVault('r3.md', 'three\n')
      const ok = await app.request('/api/v1/vault/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'r3.md' }),
      })
      expect(ok.status).toBe(200)
      expect(((await ok.json()) as { action: string }).action).toBe('created')

      const files = (await (await app.request('/api/v1/vault/files')).json()) as Array<{ rel_path: string }>
      expect(files.map((f) => f.rel_path)).toEqual(['r1.md', 'r2.md', 'r3.md'])

      // 绑到别的目录 → 拒绝
      const other = mkdtempSync(join('/tmp', 'notefast-vault-other-'))
      try {
        const rt2 = createVaultRuntime({ db: getDb(), notebookId, config: makeConfig(other) })
        await expect(rt2.start({ awaitReconcile: true })).rejects.toThrow(/已绑定/)
      } finally {
        rmSync(other, { recursive: true, force: true })
      }
    } finally {
      await runtime.stop()
      getDb().query(`UPDATE notebooks SET kind = 'db', vault_root = NULL WHERE id = ?`).run(notebookId)
    }
  })
})
