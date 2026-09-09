/**
 * vault 写回：SQLite 端的编辑（编辑器 / MCP / AI 维护）→ 文件（RFC 0003）
 *
 * 默认关闭（VAULT_WRITEBACK=true 开启）。开启后：
 *   - 文档 created / updated：序列化整篇 → tmp+rename 写回映射路径；无映射（NoteFast 内新建）则按标题落到 vault 根
 *   - 文档 deleted：文件移入 vault/.trash/（忽略目录，不会被再次 ingest），映射打 deleted_at
 *   - 回声抑制：ingest 结束时记录 doc_updated_at；事件里的 doc.updated_at 与之相同 = 这次变更来自文件，不写
 *   - 乐观并发：写前核对磁盘 sha 与映射 sha；不一致 = 外部工具已改，拒绝覆盖并记审计事件
 *
 * 已知限制（MVP）：整篇序列化会规范化 Markdown 排版，非 CommonMark 的 Obsidian 私有语法可能被改写；
 * 按块局部 patch 见 RFC 0003 §后续。
 */

import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { blocksToMarkdown, buildBlockTree, patchFrontmatter, readTags, type BlockRow } from '@notefast/core'
import { fetchDocBlocks, getBlockById, getLiveDocById } from '../store/blocks'
import {
  getVaultFileByDocId,
  markVaultFileDeleted,
  touchVaultFileAfterWrite,
  upsertVaultFile,
  type VaultFileRow,
} from '../store/vaultFiles'
import { subscribeDocChanges, type DocChangeEvent } from '../services/docEvents'
import { auditVault } from './audit'
import type { VaultContext } from './ingest'
import { toVaultAbsPath } from './paths'
import { VaultConflictError, writeVaultFileAtomic } from './writer'

export type WritebackOutcome =
  | { kind: 'written'; relPath: string; created: boolean }
  | { kind: 'skipped'; reason: 'echo' | 'not_vault_doc' | 'missing' | 'unchanged' }
  | { kind: 'conflict'; relPath: string }
  | { kind: 'trashed'; relPath: string }

export interface VaultWriteback {
  stop: () => void
  /** 等待队列清空（测试用） */
  idle: () => Promise<void>
  /** 直接处理一个事件（测试 / 手动触发） */
  handle: (ev: DocChangeEvent) => Promise<WritebackOutcome>
}

/** 文档 → vault 正文：不写 `# title`（标题即文件名），frontmatter 只增删改 tags，其余字段透传（RFC 0003 阶段 B） */
export function serializeVaultDocParts(
  ctx: VaultContext,
  doc: BlockRow,
  row: VaultFileRow | null = null,
): { content: string; frontmatterRaw: string } {
  const tree = buildBlockTree(fetchDocBlocks(ctx.db, doc.id))
  const root = tree[0]
  const body = root ? blocksToMarkdown(root.children ?? []) : ''
  const tags = readTags(doc)
  const frontmatterRaw = patchFrontmatter(row?.frontmatter_raw ?? null, { tags })
  const fm = frontmatterRaw ? `---\n${frontmatterRaw}\n---\n` : ''
  const content = fm + body.replace(/^\n+/, '').replace(/\n*$/, '\n')
  return { content, frontmatterRaw }
}

/** 兼容旧签名：仅返回正文（供现有测试 / 非写回方使用） */
export function serializeVaultDoc(ctx: VaultContext, doc: BlockRow, row: VaultFileRow | null = null): string {
  return serializeVaultDocParts(ctx, doc, row).content
}

/** 标题 → 文件名：去掉路径与文件系统保留字符，空则 untitled；重名追加 (n) */
export function uniqueRelPathForTitle(root: string, title: string): string {
  const stem =
    Array.from(title)
      .map((ch) => (ch.charCodeAt(0) < 0x20 || /[\\/:*?"<>|]/.test(ch) ? ' ' : ch))
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'untitled'
  let candidate = `${stem}.md`
  let n = 2
  while (existsSync(join(root, candidate))) {
    candidate = `${stem} (${n}).md`
    n++
  }
  return candidate
}

export function startVaultWriteback(
  ctx: VaultContext,
  opts: { onOutcome?: (docId: string, outcome: WritebackOutcome) => void } = {},
): VaultWriteback {
  const queue: DocChangeEvent[] = []
  let running = false
  const idleWaiters: Array<() => void> = []

  const handle = (ev: DocChangeEvent): Promise<WritebackOutcome> => ctx.lock(() => handleUnlocked(ev))

  const handleUnlocked = async (ev: DocChangeEvent): Promise<WritebackOutcome> => {
    const { db, notebookId, config } = ctx
    if (ev.kind === 'deleted') return trashDoc(ev.doc_id)

    const doc = getLiveDocById(db, ev.doc_id)
    if (!doc) return { kind: 'skipped', reason: 'missing' }
    if (doc.notebook_id !== notebookId) return { kind: 'skipped', reason: 'not_vault_doc' }

    const row = getVaultFileByDocId(db, doc.id)
    if (row && !row.deleted_at && row.doc_updated_at === doc.updated_at) {
      return { kind: 'skipped', reason: 'echo' }
    }

    const { content, frontmatterRaw } = serializeVaultDocParts(ctx, doc, row)
    const relPath = row ? row.rel_path : uniqueRelPathForTitle(config.root, doc.content)
    const abs = toVaultAbsPath(config.root, relPath)
    const expectedSha = row && !row.deleted_at ? row.content_sha256 : null

    let written
    try {
      written = await writeVaultFileAtomic(abs, content, { expectedSha })
    } catch (e) {
      if (e instanceof VaultConflictError) {
        auditVault('doc.vault_writeback_conflict', doc.id, {
          rel_path: relPath,
          expected_sha: e.expectedSha,
          actual_sha: e.actualSha,
        })
        return { kind: 'conflict', relPath }
      }
      throw e
    }

    if (row && !row.deleted_at) {
      touchVaultFileAfterWrite(db, notebookId, relPath, {
        content_sha256: written.sha256,
        size: written.size,
        mtime_ms: written.mtimeMs,
        doc_updated_at: doc.updated_at,
        frontmatter_raw: frontmatterRaw || null,
      })
    } else {
      upsertVaultFile(db, {
        notebook_id: notebookId,
        rel_path: relPath,
        doc_id: doc.id,
        content_sha256: written.sha256,
        size: written.size,
        mtime_ms: written.mtimeMs,
        doc_updated_at: doc.updated_at,
        frontmatter_raw: frontmatterRaw || null,
      })
    }
    if (written.unchanged && row) return { kind: 'skipped', reason: 'unchanged' }
    auditVault('doc.vault_written', doc.id, { rel_path: relPath, created: !row || Boolean(row.deleted_at) })
    return { kind: 'written', relPath, created: !row || Boolean(row.deleted_at) }
  }

  const trashDoc = (docId: string): WritebackOutcome => {
    const { db, notebookId, config } = ctx
    const row = getVaultFileByDocId(db, docId)
    if (!row || row.deleted_at) return { kind: 'skipped', reason: 'not_vault_doc' }
    const docRow = getBlockById(db, docId)
    if (docRow && docRow.notebook_id !== notebookId) return { kind: 'skipped', reason: 'not_vault_doc' }
    const abs = toVaultAbsPath(config.root, row.rel_path)
    if (existsSync(abs)) {
      let dest = join(config.root, '.trash', ...row.rel_path.split('/'))
      if (existsSync(dest)) dest = dest.replace(/\.md$/i, `.${Date.now()}.md`)
      mkdirSync(dirname(dest), { recursive: true })
      renameSync(abs, dest)
    }
    // 映射行保留并指向原路径：回收站恢复时 updated 事件会把文件写回原位
    markVaultFileDeleted(db, notebookId, row.rel_path)
    auditVault('doc.vault_trashed', docId, { rel_path: row.rel_path })
    return { kind: 'trashed', relPath: row.rel_path }
  }

  const drain = async () => {
    while (queue.length > 0) {
      const ev = queue.shift()!
      try {
        const outcome = await handle(ev)
        opts.onOutcome?.(ev.doc_id, outcome)
      } catch (e) {
        console.warn('[vault writeback]', ev.doc_id, e instanceof Error ? e.message : e)
      }
    }
    running = false
    while (idleWaiters.length > 0) idleWaiters.shift()!()
  }

  const unsub = subscribeDocChanges((ev) => {
    queue.push(ev)
    if (!running) {
      running = true
      void drain()
    }
  })

  return {
    stop: () => unsub(),
    idle: () =>
      new Promise<void>((resolve) => {
        if (!running && queue.length === 0) return resolve()
        idleWaiters.push(resolve)
      }),
    handle,
  }
}
