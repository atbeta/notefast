/**
 * 导入 zip 存档（自家导出档 / 通用 md zip）
 *
 * 自家档（含 notefast-archive.manifest.json）：
 * - 按 manifest 的 docId 还原文档（幂等：已存在则跳过），media 内容寻址入 AssetStore
 * - markdown 中 media/<sha><ext> 改写回 asset:<sha>
 * 通用 zip：每个 .md 为一个新文档（标题从首个 H1 / 文件名推断）。
 */

import { createHash } from 'node:crypto'
import type { getDb } from '../db'
import { ingestLocalImageRefs, saveAsset } from '../assets/store'
import { mimeForExt } from '../sync/archiveMedia'
import { ARCHIVE_MANIFEST_NAME, isArchiveManifest, type ArchiveManifest } from '../sync/archive'
import { parseZip } from '../lib/zipStore'
import { insertDocFromMarkdown, type InsertDocFromMarkdownResult } from './docImport'
import { normalizeMarkdownFileContent, resolveImportTitle } from './docFileImport'

type Db = ReturnType<typeof getDb>

/** zip 上传上限（含 media，体量远大于单文件 markdown 的 5MB 限制） */
export const MAX_ARCHIVE_IMPORT_BYTES = 500 * 1024 * 1024

const MEDIA_REF_RE = /media\/([0-9a-f]{64})(\.[a-z0-9]+)?/gi

export interface ZipImportResult {
  imported: number
  skipped: number
  failed: number
  errors: string[]
  mediaImported: number
  /** 新入库的文档（供调用方触发索引/hooks） */
  importedDocs: Array<{ docId: string; blockIds: string[] }>
}

export function importArchiveZip(
  db: Db,
  opts: { notebookId: string; bytes: Uint8Array },
): ZipImportResult {
  const entries = parseZip(opts.bytes)
  const byName = new Map<string, Uint8Array>()
  for (const e of entries) byName.set(e.name, e.data)

  let manifest: ArchiveManifest | null = null
  const manifestRaw = byName.get(ARCHIVE_MANIFEST_NAME)
  if (manifestRaw) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(manifestRaw)) as unknown
      if (isArchiveManifest(parsed)) manifest = parsed
    } catch {
      /* 非自家档：按通用 zip 处理 */
    }
  }
  const manifestByFilename = new Map<string, ArchiveManifest['files'][number]>(
    manifest?.files.map((f) => [f.filename, f]) ?? [],
  )

  // 1) media：media/<sha><ext> 内容寻址入 AssetStore（sha 与内容不符则跳过，不产生悬空 asset:）
  const importedShas = new Set<string>()
  let mediaImported = 0
  for (const [name, data] of byName) {
    const m = /^media\/([0-9a-f]{64})\.([a-z0-9]+)$/i.exec(name)
    if (!m) continue
    const sha = m[1]!.toLowerCase()
    const hash = createHash('sha256').update(data).digest('hex')
    if (hash !== sha) continue
    saveAsset(Buffer.from(data), mimeForExt(m[2]!))
    importedShas.add(sha)
    mediaImported++
  }

  // 2) 文档
  const result: ZipImportResult = { imported: 0, skipped: 0, failed: 0, errors: [], mediaImported, importedDocs: [] }
  const rewriteMedia = (markdown: string): string =>
    markdown.replace(MEDIA_REF_RE, (full, sha: string) =>
      importedShas.has(sha.toLowerCase()) ? `asset:${sha.toLowerCase()}` : full,
    )

  const mdEntries = entries.filter((e) => /\.md$/i.test(e.name) && e.name !== ARCHIVE_MANIFEST_NAME)

  /** zip 内相对路径图片的读取器：先按 md 所在目录解析，再退回 zip 根（Obsidian 习惯根目录放附件） */
  const zipReader = (mdName: string) => (relPath: string): Buffer | null => {
    const dir = mdName.includes('/') ? mdName.slice(0, mdName.lastIndexOf('/') + 1) : ''
    const candidates = [dir + relPath, relPath]
    for (const key of candidates) {
      const data = byName.get(key)
      if (data && data.length > 0) return Buffer.from(data)
    }
    return null
  }

  for (const entry of mdEntries) {
    const filename = entry.name.split('/').pop() ?? entry.name
    let markdown = normalizeMarkdownFileContent(new TextDecoder().decode(entry.data))
    // 通用 zip：md 里相对路径图片（images/foo.png）按 zip entries 收编 → asset:<sha>
    const ingested = ingestLocalImageRefs(markdown, zipReader(entry.name))
    markdown = rewriteMedia(ingested.markdown)
    if (ingested.unresolved.length > 0) {
      console.warn(`[zip-import] ${entry.name}: ${ingested.unresolved.length} 张图片未在 zip 内找到，保留原引用`)
    }
    if (!markdown.trim()) {
      result.skipped++
      continue
    }
    const mf = manifestByFilename.get(entry.name) ?? manifestByFilename.get(filename)
    const docId = mf?.docId
    const title = mf?.title ?? resolveImportTitle({ filename, markdown })

    // 自家档 + docId 已存在（含软删除）→ 幂等跳过（manifest 的 docId 是稳定还原锚）
    if (docId && db.query('SELECT id FROM blocks WHERE id = ?').get(docId)) {
      result.skipped++
      continue
    }

    try {
      const res: InsertDocFromMarkdownResult = insertDocFromMarkdown(db, {
        notebookId: opts.notebookId,
        title,
        markdown,
        rejectEmpty: true,
        ...(docId ? { docId } : {}),
      })
      result.imported++
      result.importedDocs.push({ docId: res.docId, blockIds: res.blockIds })
    } catch (e) {
      result.failed++
      result.errors.push(`${filename}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return result
}
