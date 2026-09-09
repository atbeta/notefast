/**
 * vault 块区间记录：顶层块 → body 区间 + 子树指纹（RFC 0003 阶段 C）。
 *
 * 为什么需要指纹：写回要判断「这个块到底被改过没有」。仅看内容长度 / 序列化文本不行 ——
 * mdast 会把 `_x_` 归一成 `*x*`、把 `$$` 块渲染成 ```math 围栏，未被用户改动的块
 * 序列化结果也会变，于是整篇被重排。指纹在 **ingest / 写回那一刻** 记下 DB 侧子树状态，
 * 之后只要指纹没变，就原样复用文件里的字节。
 */

import {
  buildBlockTree,
  parseMarkdownToBlocksWithSpans,
  type Block,
  type BlockSpan,
} from '@notefast/core'
import type { getDb } from '../db'
import { fetchDocBlocks } from '../store/blocks'
import {
  deleteVaultBlockSpans,
  replaceVaultBlockSpans,
  type VaultBlockSpanInput,
} from '../store/vaultSpans'
import { stablePropsJson } from '../services/blockAlign'
import { sha256Hex } from './writer'

type Db = ReturnType<typeof getDb>

/** 子树指纹：类型 + 内容 + properties + 子块（前序），与序列化无关的稳定表示 */
export function blockSubtreeHash(block: Block): string {
  const node = (b: Block): unknown => [
    b.type,
    b.content ?? '',
    stablePropsJson(b.properties ?? {}),
    (b.children ?? []).map(node),
  ]
  return sha256Hex(JSON.stringify(node(block)))
}

/** 文档的顶层块（parent_id = 文档根），按 sort 升序 */
export function topLevelBlocks(db: Db, docId: string): Block[] {
  const tree = buildBlockTree(fetchDocBlocks(db, docId))
  return tree[0]?.children ?? []
}

export interface RecordVaultSpansOptions {
  /** 入库 / 写回时使用的正文（已剥离 frontmatter，偏移相对它） */
  body: string
}

/**
 * 解析 body 得到顶层区间，与 DB 顶层块（sort 序）对齐后整表写入。
 * 对不上（块数不等、缺 position、类型/内容不符）就清空该文档的区间并返回 false ——
 * 调用方的下一步写回会自动退回整篇序列化。
 */
export function recordVaultSpans(db: Db, docId: string, opts: RecordVaultSpansOptions): boolean {
  const { blocks, spans } = parseMarkdownToBlocksWithSpans(opts.body, '', { bodyOnly: true })
  const parsedTop = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.parent_id === null)

  const current = topLevelBlocks(db, docId)
  if (parsedTop.length !== current.length) {
    deleteVaultBlockSpans(db, docId)
    return false
  }

  const rows: VaultBlockSpanInput[] = []
  for (let i = 0; i < parsedTop.length; i++) {
    const parsed = parsedTop[i]!
    const span: BlockSpan | null = spans[parsed.index] ?? null
    const block = current[i]!
    if (!span) {
      deleteVaultBlockSpans(db, docId)
      return false
    }
    // 顺序校验：解析结果必须与 DB 顶层块逐块同构，否则区间对不上号
    if (block.type !== parsed.block.type || (block.content ?? '') !== (parsed.block.content ?? '')) {
      deleteVaultBlockSpans(db, docId)
      return false
    }
    rows.push({ block_id: block.id, start: span.start, end: span.end, content_hash: blockSubtreeHash(block) })
  }

  replaceVaultBlockSpans(db, docId, rows)
  return true
}
