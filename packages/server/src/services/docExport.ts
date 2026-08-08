/**
 * 单文档导出：无图 → Markdown 文件；有图 → zip（MD + media/，asset: 改写为相对路径）。
 * 整库导出：与 Markdown 归档同构的自包含 zip（<slug>--<docId>.md + media/ + manifest）。
 */

import { extractAssetRefs, getAssetRemoteUrl, readAsset, readAssetBytes } from '../assets/store'
import { getDb } from '../db'
import { getDocById, listDocRows } from '../store/blocks'
import { extForMime, archiveMediaKey } from '../sync/archiveMedia'
import { buildZipStore, type ZipEntry } from '../lib/zipStore'
import { sanitizeFilename, archiveFilename, buildArchiveManifest, ARCHIVE_MANIFEST_NAME, type ArchiveManifest } from '../sync/archive'
import { portableDocMarkdown } from './portableMarkdown'

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
  // 便携导出：正文 + frontmatter（tags / 时间 / notefast_id）；编辑器加载不走此路径
  let markdown = portableDocMarkdown(docRow)
  const refs = extractAssetRefs(markdown)

  // 外链优先：已上传图床的 asset 在导出产物里直接用图床 URL（可分享、不依赖本地），
  // 不再打包进 zip；未外链的保持 asset: 引用并打包 media（现状）
  const remoteUrlById = new Map<string, string>()
  for (const id of refs) {
    const url = getAssetRemoteUrl(id)
    if (url) remoteUrlById.set(id, url)
  }
  if (remoteUrlById.size > 0) {
    markdown = markdown.replace(/asset:([0-9a-f]{64})/g, (full, id: string) => remoteUrlById.get(id) ?? full)
  }

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
    // 已外链的 asset 跳过打包（markdown 里已是图床 URL）
    if (remoteUrlById.has(id)) continue
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

/**
 * 整库导出：全部活文档（含 inbox/archived，与归档推送口径一致）打包为自包含 zip。
 * 输出与 Markdown 归档完全同构（<slug>--<docId>.md + media/<sha><ext> + manifest），
 * 可被自家导入器精确还原，也符合「迁移到其他产品」的可读副本用途。
 */
export function buildFullArchiveExport(): { filename: string; body: Uint8Array } {
  const db = getDb()
  const docs = listDocRows(db, { order: 'updated_asc' })
  const zipEntries: ZipEntry[] = []
  const files: ArchiveManifest['files'] = []
  // sha → 相对键（跨文档去重：同一图片只入包一次）
  const idToRel = new Map<string, string>()
  const mediaKeys: string[] = []

  for (const doc of docs) {
    const title = doc.content || 'untitled'
    const filename = archiveFilename(title, doc.id)
    const markdown = portableDocMarkdown(doc)
    const rewritten = markdown.replace(/asset:([0-9a-f]{64})/g, (full, id: string) => {
      const rel = idToRel.get(id)
      if (rel) return rel
      const found = readAsset(id)
      const bytes = readAssetBytes(id)
      if (!found || !bytes) return full
      const key = archiveMediaKey(id, extForMime(found.meta.mime))
      idToRel.set(id, key)
      mediaKeys.push(key)
      zipEntries.push({ name: key, data: new Uint8Array(bytes) })
      return key
    })
    zipEntries.push({ name: filename, data: new TextEncoder().encode(rewritten) })
    files.push({ docId: doc.id, title, filename, key: filename })
  }

  const manifest = buildArchiveManifest({ adapter: 'export', files, media: mediaKeys })
  zipEntries.push({
    name: ARCHIVE_MANIFEST_NAME,
    data: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n'),
  })

  const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return {
    filename: `notefast-export-${date}.zip`,
    body: buildZipStore(zipEntries),
  }
}
