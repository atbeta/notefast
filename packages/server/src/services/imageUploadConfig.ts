/**
 * 图床上传配置持久化（data/image-upload.config.json）
 *
 * 与 backup.config.json 同模式：core 定义类型/合并，server 负责读写。
 * 配置是「命令契约」（Typora 式），不含任何图床 SDK 或凭据——
 * 命令在 server 所在机器上执行，凭据由命令自己持有（picgo / picfast CLI 等）。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  emptyImageUploadConfig,
  mergeImageUploadConfig,
  publicImageUploadView,
  type ImageUploadConfig,
  type ImageUploadConfigInput,
} from '@notefast/core'

const CONFIG_FILE = 'image-upload.config.json'

let dataDir = ''
let cfg: ImageUploadConfig = emptyImageUploadConfig()

export function initImageUploadConfig(dir: string): ImageUploadConfig {
  dataDir = dir
  cfg = loadFromDisk()
  return cfg
}

export function getImageUploadConfig(): ImageUploadConfig {
  return cfg
}

export function getImageUploadPublicConfig(): ImageUploadConfig {
  return publicImageUploadView(cfg)
}

export function applyImageUploadConfig(incoming: ImageUploadConfigInput): ImageUploadConfig {
  cfg = mergeImageUploadConfig(incoming, cfg)
  saveToDisk(cfg)
  return cfg
}

function loadFromDisk(): ImageUploadConfig {
  if (!dataDir) return emptyImageUploadConfig()
  const path = join(dataDir, CONFIG_FILE)
  if (!existsSync(path)) return emptyImageUploadConfig()
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ImageUploadConfig>
    if (raw.mode !== 'auto' && raw.mode !== 'off') return emptyImageUploadConfig()
    return mergeImageUploadConfig(
      {
        mode: raw.mode,
        command: typeof raw.command === 'string' ? raw.command : '',
        args: Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : [],
        timeoutMs: typeof raw.timeoutMs === 'number' ? raw.timeoutMs : undefined,
      },
      emptyImageUploadConfig(),
    )
  } catch {
    return emptyImageUploadConfig()
  }
}

function saveToDisk(next: ImageUploadConfig): void {
  if (!dataDir) return
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  const path = join(dataDir, CONFIG_FILE)
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf-8')
  try { chmodSync(path, 0o600) } catch { /* Windows 不支持 */ }
}
