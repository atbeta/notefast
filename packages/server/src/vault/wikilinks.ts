/**
 * vault wikilink → `block_refs`（RFC 0002 §引用解析、计划 V-301）。
 *
 * 解析每个块的 `[[目标]]` / `[[目标|别名]]` / `[[目标#锚点]]`，按 Obsidian「最短唯一路径」
 * 命中 `vault_files.rel_path`，建 `ref_type='wikilink'` 的块 → 文档引用；解析不到或多义
 * 就记进 `vault_unresolved_links`（不抛错），目标文件后来出现时再补建（软解析的「后到先解」）。
 *
 * 引用目标是**文档根 block id**：文件改名 / 移动时文档 id 不变，引用自然保持
 * （RFC 0002 §删除、重现、改名）。锚点解析见 V-302。
 */

import { BlockType } from '@notefast/core'
import { fetchDocBlocks, getBlocksByIds } from '../store/blocks'
import { deleteRefsFromSource, findRefByPair, insertRef } from '../store/refs'
import { getVaultFileByDocId, listVaultFiles } from '../store/vaultFiles'
import {
  deleteUnresolvedForBlocks,
  listUnresolvedByTargetNames,
  replaceUnresolvedLinksForBlocks,
  type UnresolvedLinkInput,
} from '../store/vaultLinks'
import type { VaultContext } from './ingest'

export interface ParsedWikilink {
  /** 目标名（不含锚点 / 别名）；空 = 同文档锚点链接 `[[#标题]]` */
  target: string
  /** `#` 后的锚点原文（不含 `#`），无则 '' */
  anchor: string
  /** `|` 后的显示别名，无则 null */
  alias: string | null
}

const WIKILINK_RE = /\[\[([^[\]]+?)\]\]/g

/** 行内代码（`` ` `` 包裹）里的 `[[...]]` 不是链接：等长打码后再匹配 */
function maskInlineCode(content: string): string {
  return content.replace(/(`+)[^`]*?\1/g, (m) => ' '.repeat(m.length))
}

export function parseWikilinks(content: string): ParsedWikilink[] {
  if (!content || !content.includes('[[')) return []
  const masked = maskInlineCode(content)
  const out: ParsedWikilink[] = []
  for (const match of masked.matchAll(WIKILINK_RE)) {
    const at = match.index ?? 0
    // 嵌入 ![[...]] 是转写而非引用，V-303 负责渲染，这里不建 ref
    if (at > 0 && masked[at - 1] === '!') continue
    const raw = match[1]!
    const pipeAt = raw.indexOf('|')
    const head = pipeAt >= 0 ? raw.slice(0, pipeAt) : raw
    const alias = pipeAt >= 0 ? raw.slice(pipeAt + 1).trim() : null
    const hashAt = head.indexOf('#')
    const target = (hashAt >= 0 ? head.slice(0, hashAt) : head).trim()
    const anchor = hashAt >= 0 ? head.slice(hashAt + 1).trim() : ''
    if (!target && !anchor) continue
    out.push({ target, anchor, alias })
  }
  return out
}

// ───────────────────── 目标解析 ─────────────────────

export interface VaultFileIndex {
  /** rel_path 原样 → doc_id */
  byPath: Map<string, string[]>
  /** rel_path 小写 → doc_id */
  byPathLower: Map<string, string[]>
  /** 去扩展名的文件名原样 → doc_id */
  byBasename: Map<string, string[]>
  /** 去扩展名的文件名小写 → doc_id */
  byBasenameLower: Map<string, string[]>
}

function push(map: Map<string, string[]>, key: string, docId: string): void {
  const list = map.get(key)
  if (list) list.push(docId)
  else map.set(key, [docId])
}

export function emptyVaultFileIndex(): VaultFileIndex {
  return {
    byPath: new Map(),
    byPathLower: new Map(),
    byBasename: new Map(),
    byBasenameLower: new Map(),
  }
}

function basenameOf(relPath: string): string {
  return (relPath.split('/').pop() ?? relPath).replace(/\.md$/i, '')
}

/**
 * 把一个文件加进索引。
 *
 * 为什么要有增量版本：整库对账时每个文件都重建一次索引是 O(n²)——
 * 10k 文件时单次 build 就要 10ms，一轮对账白烧几分钟（V-501 实测）。
 * 对账/批量 ingest 时构建一次，之后随映射表增删改同步维护。
 */
export function indexVaultFile(index: VaultFileIndex, relPath: string, docId: string): void {
  push(index.byPath, relPath, docId)
  push(index.byPathLower, relPath.toLowerCase(), docId)
  const base = basenameOf(relPath)
  push(index.byBasename, base, docId)
  push(index.byBasenameLower, base.toLowerCase(), docId)
}

/** 从索引里摘掉一个文件（改名 / 删除时；查不到是 no-op） */
export function deindexVaultFile(index: VaultFileIndex, relPath: string, docId: string): void {
  const drop = (map: Map<string, string[]>, key: string): void => {
    const list = map.get(key)
    if (!list) return
    const next = list.filter((id) => id !== docId)
    if (next.length === 0) map.delete(key)
    else map.set(key, next)
  }
  drop(index.byPath, relPath)
  drop(index.byPathLower, relPath.toLowerCase())
  const base = basenameOf(relPath)
  drop(index.byBasename, base)
  drop(index.byBasenameLower, base.toLowerCase())
}

export function buildVaultFileIndex(ctx: VaultContext): VaultFileIndex {
  const index = emptyVaultFileIndex()
  for (const row of listVaultFiles(ctx.db, ctx.notebookId)) {
    indexVaultFile(index, row.rel_path, row.doc_id)
  }
  return index
}

/** 候选去重后唯一才认；多义（≥2 个不同文档）返回 null */
function uniqueDocId(ids: string[] | undefined): string | null {
  if (!ids || ids.length === 0) return null
  const set = new Set(ids)
  return set.size === 1 ? [...set][0]! : null
}

/** 文档可被 wikilink 命中的名字：rel_path（含 / 不含 .md）与文件名 */
export function wikilinkNamesForPath(relPath: string): string[] {
  const base = relPath.split('/').pop() ?? relPath
  const stem = base.replace(/\.md$/i, '')
  return [...new Set([relPath, relPath.replace(/\.md$/i, ''), base, stem])].filter(Boolean)
}

/**
 * 「最短唯一路径」解析：精确 rel_path（补 .md）→ 唯一 basename → basename 忽略大小写。
 * 任一档命中多个文档视为多义，返回 null（调用方记 unresolved）。
 */
export function resolveWikilinkDoc(index: VaultFileIndex, target: string): string | null {
  const t = target.trim().replace(/^\.\//, '')
  if (!t) return null
  const withMd = /\.md$/i.test(t) ? t : `${t}.md`

  const exact = uniqueDocId(index.byPath.get(withMd))
  if (exact) return exact
  const pathLower = uniqueDocId(index.byPathLower.get(withMd.toLowerCase()))
  if (pathLower) return pathLower

  const base = withMd.split('/').pop()!.replace(/\.md$/i, '')
  const byBase = uniqueDocId(index.byBasename.get(base))
  if (byBase) return byBase
  return uniqueDocId(index.byBasenameLower.get(base.toLowerCase()))
}

// ───────────────────── 锚点解析（V-302） ─────────────────────

/** Obsidian heading 比较规则：trim + 折叠空白 + 忽略大小写 */
export function normalizeHeadingSlug(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

function readObsidianBlockId(properties: string | null | undefined): string | null {
  if (!properties) return null
  try {
    const obj = JSON.parse(properties) as Record<string, unknown>
    const id = obj.obsidian_block_id
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}

/**
 * 锚点 → 文档内具体块（RFC 0002 §引用解析降级顺序）：
 * 1. `^abc123` 命中 `properties.obsidian_block_id`
 * 2. 其余按 heading 文本做 slug 比较（命中多个取第一个）
 * 找不到返回 null（调用方退化为文档级引用 + 记 unresolved）。
 */
export function resolveAnchorBlock(ctx: VaultContext, docId: string, anchor: string): string | null {
  const raw = anchor.trim()
  if (!raw) return null
  const rows = fetchDocBlocks(ctx.db, docId)

  if (raw.startsWith('^')) {
    const id = raw.slice(1)
    if (!/^[A-Za-z0-9-]+$/.test(id)) return null
    for (const row of rows) {
      if (row.id === docId) continue
      if (readObsidianBlockId(row.properties) === id) return row.id
    }
    return null
  }

  const slug = normalizeHeadingSlug(raw)
  if (!slug) return null
  for (const row of rows) {
    if (row.type !== BlockType.Heading) continue
    if (normalizeHeadingSlug(row.content ?? '') === slug) return row.id
  }
  return null
}

// ───────────────────── 与 ingest 的衔接 ─────────────────────

export interface SyncVaultWikilinksOptions {
  /**
   * 复用的文件索引（整库对账 / 批量 ingest 时由调用方构建一次并维护）。
   * 不传则内部按当前映射表构建一次——单文件交互式 ingest 的默认路径。
   */
  index?: VaultFileIndex
  /** 内容可能变了的块（updated ∪ inserted）：先删旧 ref 再重建 */
  touchedBlockIds: string[]
  /** 已删除的块：清掉它的 ref 与未解析记录 */
  deletedBlockIds?: string[]
}

/** 重算这些块的 wikilink 引用与未解析记录（调用方保证在事务提交之后） */
export function syncVaultWikilinks(ctx: VaultContext, opts: SyncVaultWikilinksOptions): void {
  const { db, notebookId } = ctx
  const deleted = [...new Set(opts.deletedBlockIds ?? [])].filter(Boolean)
  if (deleted.length > 0) {
    deleteUnresolvedForBlocks(db, deleted)
    for (const id of deleted) deleteRefsFromSource(db, id, 'wikilink')
  }

  const touched = [...new Set(opts.touchedBlockIds)].filter(Boolean)
  if (touched.length === 0) return

  const index = opts.index ?? buildVaultFileIndex(ctx)
  const unresolved: UnresolvedLinkInput[] = []

  for (const row of getBlocksByIds(db, touched)) {
    deleteRefsFromSource(db, row.id, 'wikilink')
    // 代码块内容不是链接；行内代码在 parseWikilinks 里打码
    if (row.type === BlockType.Code) continue
    const links = parseWikilinks(row.content ?? '')
    if (links.length === 0) continue

    const linked = new Set<string>()
    const linkTo = (targetBlockId: string): void => {
      if (linked.has(targetBlockId)) return
      linked.add(targetBlockId)
      // (source,target) 全局唯一：可能已有其他类型的引用，存在就跳过
      if (!findRefByPair(db, row.id, targetBlockId)) {
        insertRef(db, { sourceId: row.id, targetId: targetBlockId, refType: 'wikilink' })
      }
    }

    for (const link of links) {
      // 空目标 = 同文档锚点链接 `[[#标题]]`
      const docId = link.target ? resolveWikilinkDoc(index, link.target) : (row.root_id as string)
      if (!docId) {
        unresolved.push({ source_block_id: row.id, target_name: link.target, anchor: link.anchor })
        continue
      }
      if (!link.anchor) {
        linkTo(docId)
        continue
      }
      // 带锚点：先按 `^id` / heading 命中具体块，命中不了退化为文档级引用并记 unresolved
      const anchorBlock = resolveAnchorBlock(ctx, docId, link.anchor)
      if (anchorBlock) {
        linkTo(anchorBlock)
        continue
      }
      linkTo(docId)
      unresolved.push({ source_block_id: row.id, target_name: link.target, anchor: link.anchor })
    }
  }

  replaceUnresolvedLinksForBlocks(db, notebookId, touched, unresolved)
}

/**
 * 某文档（新建 / 更新 / 改名）出现后，补建指向它的未解析引用。
 * 只查「这个名字可能指它」的记录，不扫全表。
 */
export function resolveUnresolvedForDoc(
  ctx: VaultContext,
  docId: string,
  index?: VaultFileIndex,
): void {
  const row = getVaultFileByDocId(ctx.db, docId)
  if (!row) return
  const pending = listUnresolvedByTargetNames(ctx.db, ctx.notebookId, wikilinkNamesForPath(row.rel_path))
  if (pending.length === 0) return
  syncVaultWikilinks(ctx, {
    touchedBlockIds: [...new Set(pending.map((p) => p.source_block_id))],
    ...(index ? { index } : {}),
  })
}
