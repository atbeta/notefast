/**
 * 投影路径工具：相对路径归一化、越界守卫、忽略规则、标题推导。
 *
 * 文件身份 = 投影文件夹内的相对路径（POSIX 分隔符，无前导 `./`）。
 * 映射表与对外 API 只接受这种形式；绝对路径只在读写磁盘的最后一步出现。
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'

export class ProjectionPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectionPathError'
  }
}

const MARKDOWN_EXT = /\.(md|markdown)$/i

/** 冲突副本的文件名中缀（RFC 0007 D5）。文件名形如 `<stem>.notefast-conflict-<stamp>.md` */
export const CONFLICT_INFIX = '.notefast-conflict-'

/**
 * 命名忽略目录：**按名字整段匹配**，不是「任何以 . 开头的段」。
 *
 * vault 的原规则是后者，对用户自选的笔记文件夹过于激进——`.notes`、`.drafts`
 * 这类目录是用户正当的组织方式，整棵忽略等于把人家的一半笔记藏起来。
 * 这里只排除明确不属于笔记的东西。
 */
export const DEFAULT_IGNORED_DIRS: readonly string[] = [
  '.git',
  '.obsidian',
  '.trash',
  'node_modules',
  '__pycache__',
  '.venv',
]

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
 * 把「相对或绝对路径」解析为投影文件夹内的相对路径；
 * 越界（`../`、其他盘、根本身）抛 ProjectionPathError。
 *
 * 不解析符号链接：指向文件夹外的软链按其在文件夹内的位置处理（内容照常读取），不主动追踪。
 */
export function toProjectionRelPath(root: string, input: string): string {
  const abs = isAbsolute(input) ? resolve(input) : resolve(root, normalizeRelPath(input))
  const rel = relative(root, abs)
  if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new ProjectionPathError(`路径越出投影根目录: ${input}`)
  }
  return rel.split(sep).join('/')
}

export function toProjectionAbsPath(root: string, relPath: string): string {
  const rel = toProjectionRelPath(root, relPath)
  return resolve(root, ...rel.split('/'))
}

/**
 * 是否是我们自己生成的冲突副本。
 * 判据放在这里而不是散在调用方：入方向要把冲突副本当普通新文件导入（用户看得见），
 * 但写回等路径需要能识别它们，两边必须同判据。
 */
export function isProjectionConflictName(name: string): boolean {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? ''
  return base.includes(CONFLICT_INFIX) && isMarkdownPath(base)
}

/**
 * 忽略判定。
 *
 * - 命中 `ignore` 前缀（按**整段**匹配，`.obsidian` 不会误伤 `.obsidian-notes`）
 * - 任一段命中命名忽略目录（精确名，见 DEFAULT_IGNORED_DIRS）
 * - 隐藏**文件**（`.DS_Store`、编辑器临时文件），但隐藏**目录**不沉默忽略
 *
 * 冲突副本**不**忽略：它是用户文件，应当被导入让用户看见。
 */
export function isIgnoredRelPath(relPath: string, ignore: readonly string[] = []): boolean {
  const rel = normalizeRelPath(relPath)
  if (!rel) return true
  const segments = rel.split('/')
  const fileName = segments[segments.length - 1] ?? ''
  // 隐藏文件：点在开头且不是 . 或 ..
  if (fileName.startsWith('.') && fileName !== '.' && fileName !== '..') return true
  // 目录段：只按命名忽略表
  for (const dir of segments.slice(0, -1)) {
    if (DEFAULT_IGNORED_DIRS.includes(dir)) return true
  }
  for (const pattern of ignore) {
    const p = normalizeRelPath(pattern)
    if (!p) continue
    if (rel === p || rel.startsWith(p + '/')) return true
  }
  return false
}

/** 文件名（去扩展名）作为回退标题 */
export function titleFromRelPath(relPath: string): string {
  const base = normalizeRelPath(relPath).split('/').pop() ?? ''
  return base.replace(MARKDOWN_EXT, '').trim() || '未命名文档'
}
