/**
 * 图床上传配置持久化（data/image-upload.config.json）
 *
 * 与 backup.config.json 同模式：core 定义类型/合并，server 负责读写。
 * 配置是「命令契约」（Typora 式），不含任何图床 SDK 或凭据——
 * 命令在 server 所在机器上执行，凭据由命令自己持有（picgo / picfast CLI 等）。
 */

import {
  emptyImageUploadConfig,
  mergeImageUploadConfig,
  publicImageUploadView,
  type ImageUploadConfig,
  type ImageUploadConfigInput,
} from '@notefast/core'
import { createJsonConfigStore } from './jsonConfig'

const CONFIG_FILE = 'image-upload.config.json'

const store = createJsonConfigStore<ImageUploadConfig>({
  fileName: CONFIG_FILE,
  empty: emptyImageUploadConfig,
  parse: (raw) => {
    const r = raw as Partial<ImageUploadConfig>
    if (r.mode !== 'auto' && r.mode !== 'off') return null
    return mergeImageUploadConfig(
      {
        mode: r.mode,
        command: typeof r.command === 'string' ? r.command : '',
        args: Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === 'string') : [],
        timeoutMs: typeof r.timeoutMs === 'number' ? r.timeoutMs : undefined,
      },
      emptyImageUploadConfig(),
    )
  },
  // 历史行为：未初始化时静默跳过写盘（启动顺序早于 initAssetStore 的场景）
  uninitializedSet: 'ignore',
})

export function initImageUploadConfig(dir: string): ImageUploadConfig {
  return store.init(dir)
}

export function getImageUploadConfig(): ImageUploadConfig {
  return store.get()
}

export function getImageUploadPublicConfig(): ImageUploadConfig {
  return publicImageUploadView(store.get())
}

export function applyImageUploadConfig(incoming: ImageUploadConfigInput): ImageUploadConfig {
  store.set(mergeImageUploadConfig(incoming, store.get()))
  return store.get()
}

/** 测试钩子 */
export function _resetImageUploadConfigForTests(): void {
  store._resetForTests()
}
