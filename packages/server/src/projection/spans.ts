/**
 * 投影块区间记录：顶层块 → body 区间 + 子树指纹。
 *
 * 为什么需要指纹：写回要判断「这个块到底被改过没有」。仅看内容长度 / 序列化文本不行 ——
 * mdast 会把 `_x_` 归一成 `*x*`、把 `$$` 块渲染成 ```math 围栏，未被用户改动的块
 * 序列化结果也会变，于是整篇被重排。指纹在 **导入 / 写回那一刻** 记下 DB 侧子树状态，
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
  deleteProjectionBlockSpans,
  replaceProjectionBlockSpans,
  type ProjectionBlockSpanInput,
} from '../store/projectionSpans'
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

export interface RecordProjectionSpansOptions {
  /** 导入 / 写回时使用的正文（已剥离 frontmatter，偏移相对它） */
  body: string
}

/**
 * 解析 body 得到顶层区间，与 DB 顶层块（sort 序）对齐后整表写入。
 * 对不上（块数不等、缺 position、类型/内容不符）就清空该文档的区间并返回 false ——
 * 调用方的下一步写回会自动退回整篇序列化。
 */
/**
 * 文档根标题（`blocks.content`，type='document'）。取不到时返回空串。
 */
function docTitleOf(db: Db, docId: string): string {
  const row = db.query("SELECT content FROM blocks WHERE id = ? AND type = 'document'").get(docId) as
    | { content: string | null }
    | undefined
  return row?.content ?? ''
}

export function recordProjectionSpans(db: Db, docId: string, opts: RecordProjectionSpansOptions): boolean {
  const { blocks, spans } = parseMarkdownToBlocksWithSpans(opts.body, '', { bodyOnly: true })
  let parsedTop = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.parent_id === null)

  const current = topLevelBlocks(db, docId)

  /**
   * 跳过投影文件里那一行「文档根标题」——它**不对应任何块**。
   *
   * 序列化时 `blocksToMarkdown` 会对 document 根输出 `# {doc.content}`，
   * 而库里通常没有对应块：`insertDocFromMarkdown` 建文档时把与标题同文的首 H1 剥掉了。
   * 不跳过 → 解析 N+1 块 vs 库里 N 块 → 对齐永远失败、区间表永远为空、
   * 这类文档**永久退回整篇序列化**。
   *
   * **但判据必须是「这一行就是文档根标题」，不能是「首行是 H1」**：
   * 当正文另有一个与标题不同的 H1（`# 旧名`，文档标题是文件名 `t`）时，
   * 那一行是**真实的 heading 块**，跳过它反而会把块数与库里对不上
   * （实测踩过：无条件跳过导致所有首行为 H1 的文档区间建立失败）。
   */
  const first = parsedTop[0]?.block
  const title = (current.length > 0 ? docTitleOf(db, docId) : '').trim()
  if (
    title &&
    first &&
    first.type === 'heading' &&
    (first.properties as { headingLevel?: number } | undefined)?.headingLevel === 1 &&
    (first.content ?? '').trim() === title
  ) {
    parsedTop = parsedTop.slice(1)
  }
  if (parsedTop.length !== current.length) {
    deleteProjectionBlockSpans(db, docId)
    return false
  }

  const rows: ProjectionBlockSpanInput[] = []
  for (let i = 0; i < parsedTop.length; i++) {
    const parsed = parsedTop[i]!
    const span: BlockSpan | null = spans[parsed.index] ?? null
    const block = current[i]!
    if (!span) {
      deleteProjectionBlockSpans(db, docId)
      return false
    }
    // 顺序校验：解析结果必须与 DB 顶层块逐块同构，否则区间对不上号
    if (block.type !== parsed.block.type || (block.content ?? '') !== (parsed.block.content ?? '')) {
      deleteProjectionBlockSpans(db, docId)
      return false
    }
    rows.push({ block_id: block.id, start: span.start, end: span.end, content_hash: blockSubtreeHash(block) })
  }

  replaceProjectionBlockSpans(db, docId, rows)
  return true
}
