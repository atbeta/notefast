import { MAX_ASSET_BYTES, saveAsset } from '../assets/store'

/**
 * 导入路径（docx 内嵌图等）写入 AssetStore 前的闸：与 POST /assets 对齐。
 * 非 image/*、空内容、超 20MB → 不落盘，调用方跳过该图。
 */
export function saveImportedImage(data: Buffer, contentType: string): string | null {
  const mime = (contentType || '').split(';')[0]!.trim().toLowerCase()
  if (!mime.startsWith('image/') || data.length === 0 || data.length > MAX_ASSET_BYTES) {
    return null
  }
  const { meta } = saveAsset(data, mime)
  return `asset:${meta.id}`
}
