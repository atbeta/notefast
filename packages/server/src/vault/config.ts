/**
 * vault 模式配置加载
 *
 * 配置来源（按优先级）：
 *   1. 环境变量 VAULT_PATH（用于开发/CI）
 *   2. .notefast/config.json 里的 vault 字段（用于生产/桌面端）
 *
 * 未配置时返回 null，引擎不在 vault mode 启动。
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const DEFAULT_IGNORE = [
  '.notefast',
  '.obsidian',
  '.trash',
  '.git',
  'node_modules',
]

export interface VaultConfig {
  /** vault 根目录的绝对路径 */
  path: string
  /** 忽略的相对路径模式（glob-like，前缀匹配） */
  ignore: string[]
  /** 是否自动启动 watcher */
  watch: boolean
  /** 删除文件后保留多少天再真删 */
  staleRetentionDays: number
}

export async function loadVaultConfig(): Promise<VaultConfig | null> {
  const envPath = process.env.VAULT_PATH?.trim()
  if (envPath) {
    const abs = resolve(envPath)
    if (!existsSync(abs)) {
      throw new Error(`VAULT_PATH does not exist: ${abs}`)
    }
    return {
      path: abs,
      ignore: [...DEFAULT_IGNORE, ...(process.env.VAULT_IGNORE?.split(',') ?? [])],
      watch: process.env.VAULT_WATCH !== 'false',
      staleRetentionDays: Number(process.env.VAULT_STALE_DAYS ?? '30'),
    }
  }

  // TODO: 从 .notefast/config.json 读取（桌面端场景）
  // 目前 PoC 阶段只支持环境变量

  return null
}
