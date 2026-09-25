/**
 * 投影文件写入原语：tmp + rename，永不锁文件。
 *
 * 乐观并发：调用方传入上次导入 / 写回记录的 expectedSha；写前重读磁盘，
 * sha 不一致说明外部工具已改过 → 抛 ProjectionConflictError，不覆盖用户内容。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export class ProjectionConflictError extends Error {
  constructor(
    public readonly absPath: string,
    public readonly expectedSha: string | null,
    public readonly actualSha: string | null,
  ) {
    super(`投影文件已被外部修改: ${absPath}`)
    this.name = 'ProjectionConflictError'
  }
}

export function sha256Hex(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

export interface WriteProjectionFileOptions {
  /** 上次已知 sha；null = 期望文件不存在（新建）。undefined = 不做并发检查 */
  expectedSha?: string | null
}

export interface WriteProjectionFileResult {
  sha256: string
  size: number
  mtimeMs: number
  /** 内容与磁盘一致，未实际写入 */
  unchanged: boolean
}

export async function readProjectionFile(absPath: string): Promise<{ content: string; sha256: string; size: number; mtimeMs: number } | null> {
  let content: string
  try {
    content = await readFile(absPath, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  const st = statSync(absPath)
  return { content, sha256: sha256Hex(content), size: st.size, mtimeMs: Math.round(st.mtimeMs) }
}

export async function writeProjectionFileAtomic(
  absPath: string,
  content: string,
  opts: WriteProjectionFileOptions = {},
): Promise<WriteProjectionFileResult> {
  const current = await readProjectionFile(absPath)
  const nextSha = sha256Hex(content)

  if (opts.expectedSha !== undefined) {
    const actual = current?.sha256 ?? null
    if (actual !== opts.expectedSha && actual !== nextSha) {
      throw new ProjectionConflictError(absPath, opts.expectedSha, actual)
    }
  }
  if (current && current.sha256 === nextSha) {
    return { sha256: nextSha, size: current.size, mtimeMs: current.mtimeMs, unchanged: true }
  }

  const dir = dirname(absPath)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.nf-tmp`)
  try {
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, absPath)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      /* tmp 已不在 */
    }
    throw e
  }
  const st = statSync(absPath)
  return { sha256: nextSha, size: st.size, mtimeMs: Math.round(st.mtimeMs), unchanged: false }
}
