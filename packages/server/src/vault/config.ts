/**
 * vault mode 配置（RFC 0001 §配置）
 *
 * MVP 只支持环境变量；桌面壳后续经 /api/v1/vault/bind 持久化到 notebooks.vault_root。
 *
 *   VAULT_PATH        vault 根目录（必填，不存在则启动失败）
 *   VAULT_IGNORE      额外忽略的相对路径前缀，逗号分隔（默认已含 .obsidian/.trash/.git 等隐藏目录）
 *   VAULT_WATCH       'false' 关闭文件监听（仍可 POST /api/v1/vault/rebuild 手动重建）
 *   VAULT_WRITEBACK   'true' 开启 SQLite → 文件写回（RFC 0003；默认关闭，只做索引）
 *   VAULT_STABILITY_MS  编辑器多次写盘合并窗口（chokidar awaitWriteFinish，默认 300）
 */

import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

export interface VaultConfig {
  /** vault 根目录绝对路径（已 resolve，无尾斜杠） */
  root: string
  /** 忽略的相对路径前缀（按路径段匹配） */
  ignore: string[]
  watch: boolean
  writeback: boolean
  stabilityMs: number
}

/** 默认忽略：工具私有目录。隐藏目录（任一段以 . 开头）在 paths.isIgnored 里统一忽略，此处列出仅为显式 */
export const DEFAULT_VAULT_IGNORE = ['.notefast', '.obsidian', '.trash', '.git', 'node_modules']

export function loadVaultConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VaultConfig | null {
  const raw = env.VAULT_PATH?.trim()
  if (!raw) return null
  const root = resolve(raw).replace(/[\\/]+$/, '')
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`VAULT_PATH 不是可用目录: ${root}`)
  }
  const extra = (env.VAULT_IGNORE ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
  const stability = Number.parseInt(env.VAULT_STABILITY_MS ?? '', 10)
  return {
    root,
    ignore: [...new Set([...DEFAULT_VAULT_IGNORE, ...extra])],
    watch: env.VAULT_WATCH !== 'false',
    writeback: env.VAULT_WRITEBACK === 'true' || env.VAULT_WRITEBACK === '1',
    stabilityMs: Number.isFinite(stability) && stability >= 0 ? stability : 300,
  }
}
