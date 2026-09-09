/**
 * vault 模式下的块身份算法
 *
 * @see docs/rfcs/0002-block-identity.md
 *
 * 设计目标：
 *   - 微小编辑（< 5 字符）block ID 保持率 > 95%
 *   - 中等编辑（< 1 段重写）保持率 > 70%
 *   - 大改 / 重写 ID 自然漂移（接受）
 *
 * 标识算法：
 *   sha256(
 *     file_path        + "\x00" +   // vault 相对路径
 *     heading_path     + "\x00" +   // "H1 > H2 > H3" 形式
 *     content_window   + "\x00"     // 块内容 + 上下 1 行
 *   ).substring(0, 32)
 */

import { createHash } from 'node:crypto'

export interface BlockForId {
  /** 块的行内 Markdown 内容 */
  content: string
  /** 块在文件中的相对行号（0-based） */
  line: number
  /** 块类型（paragraph / heading / list_item 等） */
  type: string
}

export interface IdentityContext {
  /** vault 相对路径，如 "daily/2026-09-09.md" */
  filePath: string
  /** 文件完整内容（按 \n 切分的数组） */
  lines: string[]
  /** 当前块的 heading path（已解析） */
  headingPath: string
}

const WINDOW_BEFORE = 1
const WINDOW_AFTER = 1

export function vaultFingerprint(block: BlockForId, ctx: IdentityContext): string {
  const window = contentWindow(block, ctx.lines)
  const payload = [
    ctx.filePath,
    ctx.headingPath,
    block.type,
    window,
  ].join('\x00')
  return createHash('sha256').update(payload).digest('hex').substring(0, 32)
}

/**
 * 构造块的"内容窗口"：当前行 + 上下各 WINDOW_BEFORE/AFTER 行
 *
 * 用 \n 拼接而非数组 join，避免换行符边界歧义
 */
export function contentWindow(block: BlockForId, lines: string[]): string {
  const start = Math.max(0, block.line - WINDOW_BEFORE)
  const end = Math.min(lines.length - 1, block.line + WINDOW_AFTER)
  return lines
    .slice(start, end + 1)
    .map((l) => l.trim())
    .join('\n')
}

/**
 * 从 mdast 树构建 heading path map：行号 → heading chain
 *
 * 例如：
 *   # Daily
 *   ## Work
 *   ### Project X
 *   paragraph here
 *
 *   → 行 4 的 heading path = "Daily > Work > Project X"
 */
export function buildHeadingPathMap(
  lines: string[],
  headingStarts: Array<{ line: number; depth: number; text: string }>,
): Map<number, string> {
  const map = new Map<number, string>()
  const stack: Array<{ depth: number; text: string }> = []

  let hi = 0
  for (let i = 0; i < lines.length; i++) {
    while (hi < headingStarts.length && headingStarts[hi]!.line === i) {
      const h = headingStarts[hi++]!
      // pop 更浅或同级的 heading
      while (stack.length > 0 && stack[stack.length - 1]!.depth >= h.depth) {
        stack.pop()
      }
      stack.push({ depth: h.depth, text: h.text })
    }
    const path = stack.map((s) => s.text).join(' > ')
    map.set(i, path)
  }

  return map
}

export function resolveHeadingPath(line: number, map: Map<number, string>): string {
  return map.get(line) ?? ''
}

/**
 * 引用降级匹配：尝试不同的解析策略
 *
 * @see RFC 0002 §"三层降级匹配"
 */
export type ResolveResult =
  | { kind: 'exact'; blockId: string }
  | { kind: 'heading'; filePath: string; headingSlug: string }
  | { kind: 'file'; filePath: string }
  | { kind: 'broken'; original: string }

export function resolveWikiLink(
  link: string,
  index: { byId: Map<string, { filePath: string }>; byHeading: Map<string, Set<string>>; byFile: Map<string, Set<string>> },
): ResolveResult {
  // 1. 精确 ID 匹配：[[doc#^block-id]]
  const blockMatch = link.match(/^(.+)#\^([\w-]+)$/)
  if (blockMatch) {
    const [, fileRef, blockId] = blockMatch
    if (index.byId.has(blockId)) {
      return { kind: 'exact', blockId }
    }
    // 降级到 heading
    return resolveWikiLink(fileRef!, index)
  }

  // 2. heading 匹配：[[doc#heading]]
  const headingMatch = link.match(/^(.+)#(.+)$/)
  if (headingMatch) {
    const [, fileRef, heading] = headingMatch
    const slug = slugify(heading!)
    const filePath = resolveFileRef(fileRef!)
    if (index.byHeading.get(`${filePath}#${slug}`)?.size) {
      return { kind: 'heading', filePath, headingSlug: slug }
    }
  }

  // 3. 文件名匹配
  const filePath = resolveFileRef(link)
  if (index.byFile.get(filePath)?.size) {
    return { kind: 'file', filePath }
  }

  return { kind: 'broken', original: link }
}

function resolveFileRef(ref: string): string {
  // 简化：去掉 .md 扩展名
  return ref.replace(/\.md$/i, '').toLowerCase()
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5-]/g, '')
    .substring(0, 64)
}
