/**
 * Markdown 归档共享逻辑：文件名、manifest、陈旧文件清理
 */

export const ARCHIVE_MANIFEST_NAME = 'notefast-archive.manifest.json'

export interface ArchiveManifest {
  app: 'notefast'
  kind: 'markdown-archive'
  version: 1
  updatedAt: string
  adapter: string
  files: Array<{
    docId: string
    title: string
    filename: string
    /** S3 key 或 WebDAV 相对路径 */
    key: string
  }>
}

export function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/\.+/g, '.')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'untitled'
}

/** 稳定唯一文件名：标题 slug + docId，避免同名覆盖 */
export function archiveFilename(title: string, docId: string): string {
  const slug = sanitizeFilename(title || 'untitled')
  const shortId = docId.replace(/-/g, '').slice(0, 12)
  return `${slug}--${shortId}.md`
}

export function buildArchiveManifest(opts: {
  adapter: string
  files: ArchiveManifest['files']
}): ArchiveManifest {
  return {
    app: 'notefast',
    kind: 'markdown-archive',
    version: 1,
    updatedAt: new Date().toISOString(),
    adapter: opts.adapter,
    files: opts.files,
  }
}

export function isArchiveManifest(value: unknown): value is ArchiveManifest {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return (
    m.app === 'notefast' &&
    m.kind === 'markdown-archive' &&
    m.version === 1 &&
    Array.isArray(m.files)
  )
}

/** 计算应删除的陈旧 key：上一份 manifest 有、当前没有 */
export function staleArchiveKeys(
  previous: ArchiveManifest | null,
  current: ArchiveManifest,
): string[] {
  if (!previous) return []
  const keep = new Set(current.files.map((f) => f.key))
  const stale: string[] = []
  for (const f of previous.files) {
    if (!keep.has(f.key)) stale.push(f.key)
  }
  return stale
}
