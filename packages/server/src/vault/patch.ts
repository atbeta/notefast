/**
 * vault 按块局部写回（RFC 0003 阶段 C，发布门禁核心）。
 *
 * 目标：SQLite 端只改了一个块时，磁盘文件除该块所在行区间外**逐字节不变** ——
 * 未被改动的块直接复用旧字节（不重新序列化），块之间的空行也照搬，
 * 因此 mdast 的归一化（`_x_` → `*x*`、`$$` → ```math、列表缩进）不会波及整篇。
 *
 * 返回 null = 无法安全局部改写（没有区间记录、区间越界 / 重叠、文档无块），
 * 调用方退回整篇序列化并记审计。
 */

import { patchFrontmatter, stripDocFrontmatter, type FrontmatterPatch } from '@notefast/core'
import type { VaultBlockSpanInput, VaultBlockSpanRow } from '../store/vaultSpans'

/** 当前顶层块：指纹 + 序列化文本（仅在指纹与记录不符时使用） */
export interface PatchBlock {
  id: string
  /** 当前子树指纹（blockSubtreeHash） */
  hash: string
  /** 序列化文本（不含尾部换行） */
  text: string
}

export interface VaultPatchResult {
  body: string
  /** 新正文的区间记录，可直接整表写回 */
  spans: VaultBlockSpanInput[]
}

/**
 * 在旧正文上做区间编辑。
 *
 * 组装规则：
 * - 指纹未变的块 → 复制旧字节
 * - 相邻且顺序未变的两个块 → 复制它们之间的旧空行（不规则空行、行尾空格都保住）
 * - 其余位置（改动 / 新增块的接缝）→ 用 NoteFast 约定 `\n\n`
 * - 首块前、末块后的空白：仅当首 / 末块仍是原来的首 / 末块时照搬，否则用缺省（空 / `\n`）
 */
export function patchVaultBody(opts: {
  oldBody: string
  oldSpans: VaultBlockSpanRow[]
  blocks: PatchBlock[]
}): VaultPatchResult | null {
  const { oldBody, oldSpans, blocks } = opts
  if (oldSpans.length === 0 || blocks.length === 0) return null

  // 旧区间校验：有序、不重叠、不越界、block_id 唯一
  const oldIndex = new Map<string, number>()
  let prevEnd = 0
  for (let i = 0; i < oldSpans.length; i++) {
    const span = oldSpans[i]!
    if (span.end <= span.start || span.start < prevEnd || span.end > oldBody.length) return null
    if (oldIndex.has(span.block_id)) return null
    oldIndex.set(span.block_id, i)
    prevEnd = span.end
  }

  // 旧块之间的「缝隙」：gaps[i] 在 oldSpans[i-1] 与 oldSpans[i] 之间
  const gaps: string[] = [oldBody.slice(0, oldSpans[0]!.start)]
  for (let i = 1; i < oldSpans.length; i++) {
    gaps.push(oldBody.slice(oldSpans[i - 1]!.end, oldSpans[i]!.start))
  }
  gaps.push(oldBody.slice(oldSpans[oldSpans.length - 1]!.end))

  const spans: VaultBlockSpanInput[] = []
  let out = ''
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!
    const oldAt = oldIndex.get(block.id)
    const reuse = oldAt !== undefined && oldSpans[oldAt]!.content_hash === block.hash
    const text = reuse ? oldBody.slice(oldSpans[oldAt]!.start, oldSpans[oldAt]!.end) : block.text

    if (i === 0) {
      out += gaps[0]!
    } else {
      const prevOld = oldIndex.get(blocks[i - 1]!.id)
      const adjacent = prevOld !== undefined && oldAt !== undefined && oldAt === prevOld + 1
      out += adjacent ? gaps[oldAt!]! : '\n\n'
    }

    const start = out.length
    out += text
    spans.push({ block_id: block.id, start, end: out.length, content_hash: block.hash })
  }

  const lastOld = oldIndex.get(blocks[blocks.length - 1]!.id)
  const lastIsOriginalTail = lastOld !== undefined && lastOld === oldSpans.length - 1
  out += lastIsOriginalTail ? gaps[gaps.length - 1]! : '\n'

  return { body: out, spans }
}

export interface PatchVaultContentResult {
  /** 完整文件内容（frontmatter + 局部改写后的正文） */
  content: string
  /** 正文（不含 frontmatter），供刷新区间记录 */
  body: string
  frontmatterRaw: string
  spans: VaultBlockSpanInput[]
}

/**
 * 在磁盘原文上做局部改写：frontmatter 行级 patch + 正文区间编辑。
 * 返回 null = 无法安全局部改写，调用方退回整篇序列化。
 */
export function patchVaultContent(opts: {
  diskContent: string
  oldSpans: VaultBlockSpanRow[]
  blocks: PatchBlock[]
  frontmatterPatch: FrontmatterPatch
}): PatchVaultContentResult | null {
  const stripped = stripDocFrontmatter(opts.diskContent)
  const patched = patchVaultBody({ oldBody: stripped.body, oldSpans: opts.oldSpans, blocks: opts.blocks })
  if (!patched) return null

  const frontmatterRaw = patchFrontmatter(stripped.raw, opts.frontmatterPatch)
  const fm = frontmatterRaw ? `---\n${frontmatterRaw}\n---\n` : ''
  return { content: fm + patched.body, body: patched.body, frontmatterRaw, spans: patched.spans }
}
