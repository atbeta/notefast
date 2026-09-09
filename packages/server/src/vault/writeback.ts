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
import {
  blocksToMarkdown,
  buildBlockTree,
  patchFrontmatter,
  type BlockRow,
  type FrontmatterPatch,
} from '@notefast/core'
import { fetchDocBlocks, getBlockById, getLiveDocById } from '../store/blocks'
import {
  getVaultFileByDocId,
  markVaultFileDeleted,
  touchVaultFileAfterWrite,
  upsertVaultFile,
  type VaultFileRow,
} from '../store/vaultFiles'
import {
  listVaultBlockSpans,
  replaceVaultBlockSpans,
  type VaultBlockSpanInput,
} from '../store/vaultSpans'
import { subscribeDocChanges, type DocChangeEvent } from '../services/docEvents'
import { auditVault } from './audit'
import type { VaultConfig } from './config'
import type { VaultContext } from './ingest'
import { readVaultDocMeta, vaultMetaHash } from './meta'
import { patchVaultContent, type PatchBlock } from './patch'
import { toVaultAbsPath, toVaultRelPath } from './paths'
import { blockSubtreeHash, recordVaultSpans, topLevelBlocks } from './spans'
import { readVaultFile, VaultConflictError, writeVaultFileAtomic } from './writer'

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

/**
 * 文档 → vault 正文：不写 `# title`（标题即文件名）。
 * frontmatter 由 `patchFrontmatter` 行级透传：只增删改 tags / notefast_ai_exclude /
 * notefast_status 三键，用户手写的其余字段逐字节保留（RFC 0003 阶段 B）。
 */
export function serializeVaultDocParts(
  ctx: VaultContext,
  doc: BlockRow,
  row: VaultFileRow | null = null,
): { content: string; frontmatterRaw: string; body: string } {
  const tree = buildBlockTree(fetchDocBlocks(ctx.db, doc.id))
  const root = tree[0]
  const body = (root ? blocksToMarkdown(root.children ?? []) : '').replace(/^\n+/, '').replace(/\n*$/, '\n')
  const meta = readVaultDocMeta(doc)
  const frontmatterRaw = patchFrontmatter(row?.frontmatter_raw ?? null, {
    tags: meta.tags,
    // 缺省值（ai_exclude=false、status=note）不写键，已有键则删掉
    notefast_ai_exclude: meta.aiExclude,
    notefast_status: meta.status === 'inbox' ? 'inbox' : 'note',
  })
  const fm = frontmatterRaw ? `---\n${frontmatterRaw}\n---\n` : ''
  return { content: fm + body, frontmatterRaw, body }
}

/** 当前顶层块 → 局部改写输入（指纹 + 序列化文本） */
function patchBlocksOf(ctx: VaultContext, docId: string): PatchBlock[] {
  return topLevelBlocks(ctx.db, docId).map((block) => ({
    id: block.id,
    hash: blockSubtreeHash(block),
    // 单个块序列化会带一个尾部换行，区间编辑自己负责接缝，去掉它
    text: blocksToMarkdown([block]).replace(/\n+$/, ''),
  }))
}

/** 兼容旧签名：仅返回正文（供现有测试 / 非写回方使用） */
export function serializeVaultDoc(ctx: VaultContext, doc: BlockRow, row: VaultFileRow | null = null): string {
  return serializeVaultDocParts(ctx, doc, row).content
}

/** 标题 → 文件名：去掉路径与文件系统保留字符，空则 untitled；重名追加 (n) */
export function uniqueRelPathForTitle(root: string, title: string, hintPath?: string | null): string {
  const stem =
    Array.from(title)
      .map((ch) => (ch.charCodeAt(0) < 0x20 || /[\\/:*?"<>|]/.test(ch) ? ' ' : ch))
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'untitled'

  // 落盘位置提示（MCP create_doc 的 path）：以 .md 结尾视为完整文件名，否则视为目录；
  // 越界路径由 toVaultRelPath 抛错，这里退回 vault 根
  let dir = ''
  let base = `${stem}.md`
  if (hintPath) {
    let rel = ''
    try {
      rel = toVaultRelPath(root, hintPath)
    } catch {
      rel = ''
    }
    if (rel) {
      const slash = rel.lastIndexOf('/')
      if (/\.md$/i.test(rel)) {
        dir = slash >= 0 ? rel.slice(0, slash + 1) : ''
        base = slash >= 0 ? rel.slice(slash + 1) : rel
      } else {
        dir = rel.endsWith('/') ? rel : `${rel}/`
      }
    }
  }

  let candidate = `${dir}${base}`
  let n = 2
  while (existsSync(join(root, candidate))) {
    candidate = `${dir}${base.replace(/\.md$/i, '')} (${n}).md`
    n++
  }
  return candidate
}

/** 文档根 properties.vault_hint_path（MCP create_doc 的 path 参数落在这里） */
function vaultHintPathOf(doc: BlockRow): string | null {
  try {
    const props = JSON.parse(doc.properties || '{}') as Record<string, unknown>
    const hint = props.vault_hint_path
    return typeof hint === 'string' && hint.trim() ? hint.trim() : null
  } catch {
    return null
  }
}

/** 冲突副本文件名时间戳：yyyyMMdd-HHmmss */
function conflictStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 冲突时把 NoteFast 版本另存到同目录 `<stem>.notefast-conflict-<ts>.md`（tmp+rename），
 * 不覆盖用户文件。副本会被 watcher 当新文档 ingest —— 这是预期（用户可见、可自行合并）。
 * 返回相对 vault 根的路径（记进审计与 status.conflicts）。
 */
async function writeConflictCopy(
  config: VaultConfig,
  abs: string,
  content: string,
): Promise<string | null> {
  const dir = dirname(abs)
  const stem = abs.slice(dir.length + 1).replace(/\.md$/i, '')
  const stamp = conflictStamp()
  let dest = join(dir, `${stem}.notefast-conflict-${stamp}.md`)
  let n = 2
  while (existsSync(dest)) {
    dest = join(dir, `${stem}.notefast-conflict-${stamp}-${n}.md`)
    n++
  }
  try {
    await writeVaultFileAtomic(dest, content)
  } catch (e) {
    console.warn('[vault writeback] 冲突副本写入失败:', e instanceof Error ? e.message : e)
    return null
  }
  return dest.startsWith(config.root) ? dest.slice(config.root.length).replace(/^[/\\]/, '') : dest
}

export function startVaultWriteback(
  ctx: VaultContext,
  opts: { onOutcome?: (docId: string, outcome: WritebackOutcome) => void } = {},
): VaultWriteback {
  const queue: DocChangeEvent[] = []
  let running = false
  const idleWaiters: Array<() => void> = []

  const handle = (ev: DocChangeEvent): Promise<WritebackOutcome> => ctx.lock(() => handleUnlocked(ev))

  /** 冲突统一出口：另存 NoteFast 版本 + 审计（附 conflict_path），原文件保持用户版本 */
  const conflictWithCopy = async (args: {
    docId: string
    relPath: string
    abs: string
    expectedSha: string | null
    actualSha: string | null
    content: string
  }): Promise<WritebackOutcome> => {
    const conflictPath = await writeConflictCopy(ctx.config, args.abs, args.content)
    auditVault('doc.vault_writeback_conflict', args.docId, {
      rel_path: args.relPath,
      expected_sha: args.expectedSha,
      actual_sha: args.actualSha,
      ...(conflictPath ? { conflict_path: conflictPath } : {}),
    })
    return { kind: 'conflict', relPath: args.relPath }
  }

  const handleUnlocked = async (ev: DocChangeEvent): Promise<WritebackOutcome> => {
    const { db, notebookId, config } = ctx
    if (ev.kind === 'deleted') return trashDoc(ev.doc_id)

    const doc = getLiveDocById(db, ev.doc_id)
    if (!doc) return { kind: 'skipped', reason: 'missing' }
    if (doc.notebook_id !== notebookId) return { kind: 'skipped', reason: 'not_vault_doc' }

    const row = getVaultFileByDocId(db, doc.id)
    const metaHash = vaultMetaHash(doc)
    // 回声判定 = 时间戳相同 **且** 元数据指纹相同。
    // 只看时间戳会漏掉 tags / ai_exclude 这类 touchUpdatedAt:false 的变更（RFC 0003 §回声抑制）
    if (row && !row.deleted_at && row.doc_updated_at === doc.updated_at && row.meta_hash === metaHash) {
      return { kind: 'skipped', reason: 'echo' }
    }

    const meta = readVaultDocMeta(doc)
    const frontmatterPatch: FrontmatterPatch = {
      tags: meta.tags,
      notefast_ai_exclude: meta.aiExclude,
      notefast_status: meta.status === 'inbox' ? 'inbox' : 'note',
    }

    const existing = Boolean(row && !row.deleted_at)
    const relPath = row ? row.rel_path : uniqueRelPathForTitle(config.root, doc.content, vaultHintPathOf(doc))
    const abs = toVaultAbsPath(config.root, relPath)
    const expectedSha = existing ? row!.content_sha256 : null

    // 优先按块局部改写：未改动的块直接复用磁盘字节（RFC 0003 阶段 C）。
    // 拿不到完整区间记录 / 区间失效 → 退回整篇序列化并记审计。
    let plan: {
      content: string
      body: string
      frontmatterRaw: string
      spans: VaultBlockSpanInput[] | null
      mode: 'patch' | 'full'
    } | null = null

    if (existing) {
      const disk = await readVaultFile(abs)
      // 磁盘已被外部改过 → 不解析、不覆盖；NoteFast 版本另存副本（与 writer 的乐观并发同一判定）
      if (disk && disk.sha256 !== expectedSha) {
        return conflictWithCopy({
          docId: doc.id,
          relPath,
          abs,
          expectedSha,
          actualSha: disk.sha256,
          content: serializeVaultDocParts(ctx, doc, row).content,
        })
      }
      if (disk) {
        const patched = patchVaultContent({
          diskContent: disk.content,
          oldSpans: listVaultBlockSpans(db, doc.id),
          blocks: patchBlocksOf(ctx, doc.id),
          frontmatterPatch,
        })
        if (patched) plan = { ...patched, mode: 'patch' }
      }
    }
    if (!plan) {
      const parts = serializeVaultDocParts(ctx, doc, row)
      plan = { ...parts, spans: null, mode: 'full' }
      if (existing) auditVault('doc.vault_written_full', doc.id, { rel_path: relPath })
    }

    let written
    try {
      written = await writeVaultFileAtomic(abs, plan.content, { expectedSha })
    } catch (e) {
      if (e instanceof VaultConflictError) {
        return conflictWithCopy({
          docId: doc.id,
          relPath,
          abs,
          expectedSha,
          actualSha: e.actualSha,
          content: plan.content,
        })
      }
      throw e
    }

    if (existing) {
      touchVaultFileAfterWrite(db, notebookId, relPath, {
        content_sha256: written.sha256,
        size: written.size,
        mtime_ms: written.mtimeMs,
        doc_updated_at: doc.updated_at,
        frontmatter_raw: plan.frontmatterRaw || null,
        meta_hash: metaHash,
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
        frontmatter_raw: plan.frontmatterRaw || null,
        meta_hash: metaHash,
      })
    }

    // 刷新区间记录：局部改写直接用新偏移，整篇则按写出的正文重新解析
    if (plan.spans) replaceVaultBlockSpans(db, doc.id, plan.spans)
    else recordVaultSpans(db, doc.id, { body: plan.body })

    if (written.unchanged && row) return { kind: 'skipped', reason: 'unchanged' }
    auditVault('doc.vault_written', doc.id, { rel_path: relPath, created: !existing, mode: plan.mode })
    return { kind: 'written', relPath, created: !existing }
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
