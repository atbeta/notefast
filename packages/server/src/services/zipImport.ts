/**
 * 导入 zip 存档（自家导出档 / 通用 md zip）
 *
 * 自家档（含 notefast-archive.manifest.json）：
 * - 按 manifest 的 docId 还原文档（幂等：已存在则跳过），media 内容寻址入 AssetStore
 * - markdown 中 media/<sha><ext> 改写回 asset:<sha>
 * 通用 zip：每个 .md 为一个新文档（标题从首个 H1 / 文件名推断）；
 * 无 YAML tags 时第一层目录作为 tag（untagged/media/__MACOSX 除外）。
 */

import { stripDocFrontmatter, normalizeTagList } from '@notefast/core'
import { createHash } from 'node:crypto'
import type { getDb } from '../db'
import { ingestLocalImageRefs, saveAsset } from '../assets/store'
import { mimeForExt } from '../sync/archiveMedia'
import { ARCHIVE_MANIFEST_NAME, ARCHIVE_UNTAGGED_DIR, isArchiveManifest, type ArchiveManifest } from '../sync/archive'
import { parseZip } from '../lib/zipStore'
import { insertDocFromMarkdown, type InsertDocFromMarkdownResult } from './docImport'
import { normalizeMarkdownFileContent, resolveImportTitle } from './docFileImport'

type Db = ReturnType<typeof getDb>

/** zip 上传上限（含 media，体量远大于单文件 markdown 的 5MB 限制） */
export const MAX_ARCHIVE_IMPORT_BYTES = 500 * 1024 * 1024

const MEDIA_REF_RE = /media\/([0-9a-f]{64})(\.[a-z0-9]+)?/gi

const SKIP_FOLDER_TAGS = new Set([
  ARCHIVE_UNTAGGED_DIR.toLowerCase(),
  'media',
  '__macosx',
])

/**
 * 通用 zip：第一层目录当作 tag。根文件、untagged/media/__MACOSX 不打。
 * 自家档（有 manifest）不要走这里——标签以 YAML frontmatter 为准。
 */
export function folderTagFromZipPath(entryName: string): string | null {
  const parts = entryName.split(/[/\\]/).filter((s) => s && s !== '.')
  if (parts.length < 2) return null
  const first = parts[0]!
  if (SKIP_FOLDER_TAGS.has(first.toLowerCase())) return null
  return first
}

/** zip 内相对路径：先按 md 所在目录解析（含 ..），再退回 zip 根 */
function resolveZipRel(mdName: string, relPath: string, byName: Map<string, Uint8Array>): Buffer | null {
  const dir = mdName.includes('/') ? mdName.slice(0, mdName.lastIndexOf('/') + 1) : ''
  const candidates = [normalizeZipPath(dir + relPath), normalizeZipPath(relPath)]
  for (const key of candidates) {
    const data = byName.get(key)
    if (data && data.length > 0) return Buffer.from(data)
  }
  return null
}

function normalizeZipPath(p: string): string {
  const parts: string[] = []
  for (const seg of p.split(/[/\\]/)) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

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
    saveAsset(Buffer.from(data), mimeForExt(m[2]!), m[0]!.split('/').pop()!)
    importedShas.add(sha)
    mediaImported++
  }

  // 2) 文档
  const result: ZipImportResult = { imported: 0, skipped: 0, failed: 0, errors: [], mediaImported, importedDocs: [] }
  const rewriteMedia = (markdown: string): string =>
    markdown.replace(MEDIA_REF_RE, (full, sha: string) =>
      importedShas.has(sha.toLowerCase()) ? `asset:${sha.toLowerCase()}` : full,
    )

  const mdEntries = entries.filter((e) => /\.(md|markdown|mdown|mkd|txt)$/i.test(e.name) && e.name !== ARCHIVE_MANIFEST_NAME)

  for (const entry of mdEntries) {
    const filename = entry.name.split('/').pop() ?? entry.name
    let markdown = normalizeMarkdownFileContent(new TextDecoder().decode(entry.data))
    // 通用 zip：md 里相对路径图片（images/foo.png）按 zip entries 收编 → asset:<sha>
    const ingested = ingestLocalImageRefs(markdown, (rel) => resolveZipRel(entry.name, rel, byName))
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
    const folderTag = !manifest ? folderTagFromZipPath(entry.name) : null
    const hasFmTags = Boolean(stripDocFrontmatter(markdown).meta?.tags?.length)
    const tags = folderTag && !hasFmTags ? normalizeTagList([folderTag]) : undefined

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
        ...(tags?.length ? { tags } : {}),
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
