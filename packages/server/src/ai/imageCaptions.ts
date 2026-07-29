/**
 * 图片理解：asset → caption 缓存与生成
 *
 * - caption 以 asset sha256 为主键缓存（内容寻址，跨文档共享，天然幂等）
 * - 仅在「设置开启图片理解 + chat 已配置 + asset 是图片」时生成
 * - 生成失败返回 null：索引降级为无 caption 的纯文本，不阻断主流程
 * - 模型更换后：hasFreshVector 指纹不变，但 content_hash 以拼接 caption 后的
 *   文本计算——caption 变化会自然触发重索引，无需额外失效机制
 *
 * 索引文本的完整组装（标题/章节/标签 + 正文 + caption）见 ai/indexedText.ts。
 */

import { getDb } from '../db'
import { getRuntime, hasRuntime } from '../services/aiRuntime'
import { readAsset, readAssetBytes } from '../assets/store'

/** 图片理解是否启用（设置开关 + chat 可用） */
export function visionEnabled(): boolean {
  if (!hasRuntime()) return false
  try {
    return getRuntime().hasVision()
  } catch {
    return false
  }
}

function currentChatModel(): string {
  try {
    return getRuntime().chatProviderDef()?.chatModel ?? ''
  } catch {
    return ''
  }
}

/** 读取缓存的 caption（无缓存返回 null） */
export function getCachedCaption(assetId: string): string | null {
  const row = getDb()
    .query('SELECT caption FROM asset_captions WHERE id = ?')
    .get(assetId) as { caption: string } | undefined
  return row?.caption ?? null
}

/**
 * 取 asset 的 caption：先查缓存，未命中且视觉可用时生成并缓存。
 * 非图片 asset / 视觉未启用 / 生成失败均返回 null。
 */
export async function captionForAsset(assetId: string): Promise<string | null> {
  const cached = getCachedCaption(assetId)
  if (cached) return cached

  if (!visionEnabled()) return null
  const asset = readAsset(assetId)
  if (!asset || !asset.meta.mime.startsWith('image/')) return null
  const buf = readAssetBytes(assetId)
  if (!buf) return null

  try {
    const caption = await getRuntime().describeImage(buf.toString('base64'), asset.meta.mime)
    if (!caption) return null
    getDb()
      .query('INSERT OR REPLACE INTO asset_captions (id, caption, model, created_at) VALUES (?, ?, ?, ?)')
      .run(assetId, caption, currentChatModel(), new Date().toISOString())
    return caption
  } catch (e) {
    console.warn(`[imageCaptions] caption 生成失败 ${assetId.slice(0, 8)}:`, e instanceof Error ? e.message : e)
    return null
  }
}
