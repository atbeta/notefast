import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SECRET_FILES = ['ai.config.json', 'backup.config.json', 'sync.config.json', 'api.key']

export function auditSecretFilePermissions(dataDir: string): void {
  for (const file of SECRET_FILES) {
    const path = join(dataDir, file)
    auditSingleFile(path)
  }
  auditDirPerms(dataDir)
}

function auditSingleFile(path: string): void {
  if (!existsSync(path)) return
  try {
    const stat = statSync(path)
    if ((stat.mode & 0o077) !== 0) {
      console.warn(`⚠ 安全审计：${path} 权限过于宽松（当前 ${(stat.mode & 0o777).toString(8)}，建议 600）`)
    }
  } catch {
    /* 权限检查失败静默跳过（Windows / 无读取权限） */
  }
}

function auditDirPerms(dataDir: string): void {
  try {
    const stat = statSync(dataDir)
    if ((stat.mode & 0o077) !== 0) {
      console.warn(`⚠ 安全审计：dataDir ${dataDir} 权限过于宽松（当前 ${(stat.mode & 0o777).toString(8)}，建议 700）`)
    }
  } catch {
    /* ignore */
  }
}
