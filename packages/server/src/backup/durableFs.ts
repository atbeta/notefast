/**
 * 持久化文件替换：write → fsync(file) → rename → fsync(dir)
 */

import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function fsyncPath(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * 避免崩溃落在「rename 已见但文件体未落盘」或空文件占位窗口。
 */
export function durableReplaceFile(
  stagingPath: string,
  targetPath: string,
  contents: Buffer | string,
): void {
  writeFileSync(stagingPath, contents)
  fsyncPath(stagingPath)
  renameSync(stagingPath, targetPath)
  try {
    fsyncPath(dirname(targetPath))
  } catch {
    // Windows 等环境可能无法对目录 fd 做 fsync；文件本身已 fsync
  }
}
