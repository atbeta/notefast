/**
 * 单文档导出：无图 → Markdown 文件；有图 → zip（MD + media/，asset: 改写为相对路径）。
 */

import { blocksToMarkdown, buildBlockTree } from '@notefast/core'
import { extractAssetRefs, readAsset, readAssetBytes } from '../assets/store'
import { getDb } from '../db'
import { fetchDocBlocks, getDocById } from '../store/blocks'
import { sanitizeFilename } from '../sync/archive'
import { extForMime } from '../sync/archiveMedia'
import { buildZipStore } from '../lib/zipStore'

/** Content-Disposition：ASCII fallback + UTF-8 filename* */
export function contentDispositionAttachment(filename: string): string {
  const ascii = filename
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .replace(/\s+/g, '_') || 'export'
  const encoded = encodeURIComponent(filename).replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

export type DocExportFile =
  | {
      kind: 'markdown'
      filename: string
      body: Uint8Array
      contentType: 'text/markdown; charset=utf-8'
    }
  | {
      kind: 'zip'
      filename: string
      body: Uint8Array
      contentType: 'application/zip'
    }

/**
 * 构建可下载的单文档导出。文档不存在返回 null。
 * 悬空 asset: 引用保留原样（不进 zip media/）。
 */
export function buildDocExportFile(docId: string): DocExportFile | null {
  const db = getDb()
  const docRow = getDocById(db, docId)
  if (!docRow) return null

  const title = docRow.content || 'untitled'
  const slug = sanitizeFilename(title)
  const tree = buildBlockTree(fetchDocBlocks(db, docId))
  let markdown = blocksToMarkdown(tree)
  const refs = extractAssetRefs(markdown)

  if (refs.length === 0) {
    return {
      kind: 'markdown',
      filename: `${slug}.md`,
      body: new TextEncoder().encode(markdown),
      contentType: 'text/markdown; charset=utf-8',
    }
  }

  const idToRel = new Map<string, string>()
  const zipEntries: Array<{ name: string; data: Uint8Array }> = []

  for (const id of refs) {
    const found = readAsset(id)
    const bytes = readAssetBytes(id)
    if (!found || !bytes) continue
    const rel = `media/${id}${extForMime(found.meta.mime)}`
    idToRel.set(id, rel)
    zipEntries.push({ name: rel, data: new Uint8Array(bytes) })
  }

  if (idToRel.size > 0) {
    markdown = markdown.replace(/asset:([0-9a-f]{64})/g, (full, id: string) => idToRel.get(id) ?? full)
  }

  // 全部悬空：仍给纯 MD（不至于空 zip）
  if (zipEntries.length === 0) {
    return {
      kind: 'markdown',
      filename: `${slug}.md`,
      body: new TextEncoder().encode(markdown),
      contentType: 'text/markdown; charset=utf-8',
    }
  }

  zipEntries.unshift({
    name: `${slug}.md`,
    data: new TextEncoder().encode(markdown),
  })

  return {
    kind: 'zip',
    filename: `${slug}.zip`,
    body: buildZipStore(zipEntries),
    contentType: 'application/zip',
  }
}
