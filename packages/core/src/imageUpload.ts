/**
 * 图床上传配置（Typora 式命令契约）
 *
 * 设计（与 AGENTS.md 一致）：
 * - 图片仍先本地内容寻址存储（asset:<id> 语义不变，编辑/导入/导出零改动）
 * - mode=auto 时异步 spawn 外部命令（PicGo / upgit / picfast CLI / 任意脚本）
 *   把图片传到图床，返回 URL 写回 assets.remote_url；GET /assets/:id 302 到图床 URL
 * - 失败静默降级本地（不阻塞编辑、不丢图），与具体图床零耦合——
 *   notefast 只定义「命令契约」：参数追加图片路径，stdout 每行一个 URL
 */

import { z } from 'zod'

/** 命令默认超时：30s（与 AI provider 默认一致量级） */
export const DEFAULT_IMAGE_UPLOAD_TIMEOUT_MS = 30_000

/** 图床命令契约：command [args...] <image_path> → stdout 每行一个 http(s) URL */
export interface ImageUploadConfig {
  version: 1
  /** 'off'=不处理（默认，本地存储）；'auto'=本地存 + 异步上传图床 */
  mode: 'off' | 'auto'
  /** 上传命令（PATH 可解析的可执行名或绝对路径），如 picgo / upgit / picfast */
  command: string
  /** 固定参数（图片路径由系统追加在最后） */
  args: string[]
  /** 命令超时（毫秒） */
  timeoutMs: number
}

export interface ImageUploadConfigInput {
  mode?: 'off' | 'auto'
  command?: string
  args?: string[]
  timeoutMs?: number
}

export function emptyImageUploadConfig(): ImageUploadConfig {
  return {
    version: 1,
    mode: 'off',
    command: '',
    args: [],
    timeoutMs: DEFAULT_IMAGE_UPLOAD_TIMEOUT_MS,
  }
}

/** 无内嵌密钥（命令是本地进程），原样返回 */
export function publicImageUploadView(cfg: ImageUploadConfig): ImageUploadConfig {
  return cfg
}

/** 合并 PUT 请求与磁盘配置：mode 只接受 off/auto；command 去空格；args 只留字符串 */
export function mergeImageUploadConfig(
  incoming: ImageUploadConfigInput,
  existing: ImageUploadConfig,
): ImageUploadConfig {
  return {
    version: 1,
    mode: incoming.mode === 'auto' ? 'auto' : 'off',
    command: typeof incoming.command === 'string' ? incoming.command.trim() : existing.command,
    args: Array.isArray(incoming.args)
      ? incoming.args.filter((a): a is string => typeof a === 'string')
      : existing.args,
    timeoutMs: clampTimeout(incoming.timeoutMs ?? existing.timeoutMs),
  }
}

function clampTimeout(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_IMAGE_UPLOAD_TIMEOUT_MS
  return Math.min(300_000, Math.max(1_000, Math.round(ms)))
}

export const imageUploadConfigSchema = z.object({
  mode: z.enum(['off', 'auto']).optional(),
  command: z.string().max(512).optional(),
  args: z.array(z.string().max(512)).max(32).optional(),
  timeoutMs: z.number().int().min(1000).max(300_000).optional(),
})
