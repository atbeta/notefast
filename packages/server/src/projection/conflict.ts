/**
 * 冲突副本（RFC 0007 D5）。
 *
 * 投影的裁决方向与 vault 相反：**库赢**。外部工具在我们之后改过文件时，
 * 库里的版本继续写下去，外部版本另存为同目录副本
 * `<stem>.notefast-conflict-<yyyyMMdd-HHmmss>.md`。
 *
 * 绝不静默覆盖任何一方——副本会被 watcher 当普通新文件导入，用户看得见、可自行合并。
 */

import { existsSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { CONFLICT_INFIX } from './paths'
import { writeProjectionFileAtomic } from './writer'

/** 时间戳：本地时间，人可读，且排序稳定（`yyyyMMdd-HHmmss`） */
export function conflictStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 冲突副本的目标路径（同目录、同 stem、加中缀）。
 * 同一秒内多次冲突追加 `-2`、`-3`……避免互相覆盖。
 */
export function conflictCopyPath(absPath: string, stamp = conflictStamp()): string {
  const dir = dirname(absPath)
  const base = absPath.slice(dir.length + 1)
  const stem = base.replace(/\.(md|markdown)$/i, '')
  let dest = join(dir, `${stem}${CONFLICT_INFIX}${stamp}.md`)
  let n = 2
  while (existsSync(dest)) {
    dest = join(dir, `${stem}${CONFLICT_INFIX}${stamp}-${n}.md`)
    n++
  }
  return dest
}

export interface ConflictCopyResult {
  /** 相对投影根目录的路径；写入失败时为 null */
  relPath: string | null
  absPath: string
}

/**
 * 把「库里的版本」写到冲突副本。
 *
 * 注意写的是 `content`（库侧内容）而不是磁盘现状：磁盘现状是**对方**的版本，
 * 它本来就在用户文件里，不需要我们抄一份。这样用户拿到的副本是
 * 「NoteFast 想写的版本」，与原文件对照即可决定保留哪个。
 */
export async function writeConflictCopy(
  root: string,
  absPath: string,
  content: string,
  stamp?: string,
): Promise<ConflictCopyResult> {
  const dest = conflictCopyPath(absPath, stamp)
  try {
    await writeProjectionFileAtomic(dest, content)
  } catch (e) {
    console.warn('[projection] 冲突副本写入失败:', e instanceof Error ? e.message : e)
    return { relPath: null, absPath: dest }
  }
  const rel = relative(root, dest)
  const withinRoot = rel && !rel.startsWith('..')
  return { relPath: withinRoot ? rel.split(sep).join('/') : null, absPath: dest }
}
