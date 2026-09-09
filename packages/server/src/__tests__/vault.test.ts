/**
 * vault mode（RFC 0001 / 0002 / 0003）：文件是权威，SQLite 是派生索引。
 *
 * 覆盖：路径守卫、原子写 + 乐观并发、ingest 的块 id 稳定性、删除→回收站→重现恢复、
 * rename 配对（引用不丢）、全量对账、写回回声抑制与冲突、HTTP 路由。
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { initDb, closeDb, getDb } from '../db'
import { fetchDocBlocks, getDeletedBlockById, getLiveDocById, updateBlock } from '../store/blocks'
import { insertRef, findRefByPair } from '../store/refs'
import { getVaultFileByDocId, getVaultFileByPath, getNotebookVaultBinding, listVaultFiles } from '../store/vaultFiles'
import { insertDocFromMarkdown } from '../services/docImport'
import { readTags } from '@notefast/core'
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
    const out = serializeVaultDoc(ctx, doc)
    expect(out.startsWith('---\ntags:\n  - x\n---\n')).toBe(true)
    expect(out).not.toContain('# s\n')
    expect(out).toContain('## Section')
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
