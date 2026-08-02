/**
 * Markdown 归档的图片处理：收集引用、上传 media、改写相对路径。
 *
 * 归档定位 = 便捷迁移 / 自包含副本：`.md` 与引用的图片（media/）一起推送，
 * `asset:<sha256>` 改写为相对路径 `media/<sha><ext>`，拿到任何地方都能渲染。
 */

import { extractAssetRefs, readAsset } from '../assets/store'

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
}

export function extForMime(mime: string): string {
  return MIME_EXT[mime.toLowerCase()] || '.bin'
}

/** 归档 media 相对键：media/<sha><ext>（与 .md 并列于归档根目录下） */
export function archiveMediaKey(sha: string, ext: string): string {
  return `media/${sha}${ext}`
}

/** 收集 markdown 中引用的 media（悬空引用跳过）→ { sha → relativeKey } */
export function collectArchiveMediaRefs(markdown: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const id of extractAssetRefs(markdown)) {
    const found = readAsset(id)
    if (!found) continue
    map.set(id, archiveMediaKey(id, extForMime(found.meta.mime)))
  }
  return map
}

/** 把 markdown 中的 asset:<sha> 引用改写为相对路径（未收集到的保留原样） */
export function rewriteAssetRefs(markdown: string, idToKey: Map<string, string>): string {
  return markdown.replace(/asset:([0-9a-f]{64})/g, (full, id: string) => idToKey.get(id) ?? full)
}
