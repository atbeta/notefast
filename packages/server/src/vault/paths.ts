/**
 * vault 路径工具：相对路径归一化、越界守卫、忽略规则、标题推导。
 *
 * 文件身份 = vault 相对路径（POSIX 分隔符，无前导 ./）。所有对外 API 与 vault_files
 * 只接受这种形式；绝对路径只在读写磁盘的最后一步出现。
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'

export class VaultPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultPathError'
  }
}

const MARKDOWN_EXT = /\.md$/i

export function isMarkdownPath(relPath: string): boolean {
  return MARKDOWN_EXT.test(relPath)
}

/** 统一成 POSIX 相对路径：去 ./、去首尾斜杠、反斜杠转正斜杠 */
export function normalizeRelPath(input: string): string {
  return input
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+|\/+$/g, '')
}

/**
 * 把「相对或绝对路径」解析为 vault 内的相对路径；越界（../、其他盘、vault 根本身）抛 VaultPathError。
 * 不解析符号链接：指向 vault 外的软链按其在 vault 内的位置处理（内容照常读取），不主动追踪。
 */
export function toVaultRelPath(root: string, input: string): string {
  const abs = isAbsolute(input) ? resolve(input) : resolve(root, normalizeRelPath(input))
  const rel = relative(root, abs)
  if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new VaultPathError(`路径越出 vault 根目录: ${input}`)
  }
  return rel.split(sep).join('/')
}

export function toVaultAbsPath(root: string, relPath: string): string {
  const rel = toVaultRelPath(root, relPath)
  return resolve(root, ...rel.split('/'))
}

/**
 * 忽略判定：任一路径段以 . 开头（隐藏目录/文件），或相对路径命中 ignore 前缀（按整段匹配，
 * `.obsidian` 不会误伤 `.obsidian-notes`）。
 */
export function isIgnoredRelPath(relPath: string, ignore: readonly string[]): boolean {
  const rel = normalizeRelPath(relPath)
  const segments = rel.split('/')
  if (segments.some((s) => s.startsWith('.'))) return true
  for (const pattern of ignore) {
    const p = normalizeRelPath(pattern)
    if (!p) continue
    if (rel === p || rel.startsWith(p + '/')) return true
  }
  return false
}

/** 文件名（去扩展名）作为回退标题；正文首个 H1 优先于它 */
export function titleFromRelPath(relPath: string): string {
  const base = normalizeRelPath(relPath).split('/').pop() ?? ''
  return base.replace(MARKDOWN_EXT, '').trim() || '未命名文档'
}
