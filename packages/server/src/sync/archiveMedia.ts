/**
 * Markdown 归档的图片处理：收集引用、上传 media、改写相对路径。
 *
 * 归档定位 = 便捷迁移 / 自包含副本：`.md` 在一层标签目录下，图片在归档根 `media/`；
 * `asset:<sha256>` 改写为相对路径 `../media/<sha><ext>`（单文档扁平导出仍用 `media/`）。
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

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bin: 'application/octet-stream',
}

/** 从扩展名推断 MIME（导入 media 时用；未知回落到 octet-stream） */
export function mimeForExt(ext: string): string {
  return EXT_MIME[ext.toLowerCase().replace(/^\./, '')] || 'application/octet-stream'
}

/** 归档 media 相对键：media/<sha><ext>（相对归档根；文档在子目录里要再加 ../） */
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

/**
 * 把 markdown 中的 asset:<sha> 引用改写为相对路径（未收集到的保留原样）。
 * 文档在一层子目录下时传 fromNestedDoc，写成 ../media/…，本地打开才能找到归档根的图片。
 */
export function rewriteAssetRefs(
  markdown: string,
  idToKey: Map<string, string>,
  fromNestedDoc = false,
): string {
  const prefix = fromNestedDoc ? '../' : ''
  return markdown.replace(/asset:([0-9a-f]{64})/g, (full, id: string) => {
    const key = idToKey.get(id)
    return key ? prefix + key : full
  })
}
