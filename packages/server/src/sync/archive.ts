/**
 * Markdown 归档共享逻辑：文件名、manifest、陈旧文件清理
 */

export const ARCHIVE_MANIFEST_NAME = 'notefast-archive.manifest.json'

/** 无标签文档在归档树里的目录名（稳定英文，不随 UI locale 变） */
export const ARCHIVE_UNTAGGED_DIR = 'untagged'

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
  /** 归档引用的 media 相对键（media/<sha><ext>）；供陈旧 media 清理 */
  media?: string[]
}

export function sanitizeFilename(name: string, maxLen = 80): string {
  return name
    // oxlint-disable-next-line no-control-regex -- 有意匹配控制字符以清洗文件名
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/\.+/g, '.')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLen) || 'untitled'
}

/**
 * 稳定唯一文件名：标题 slug + docId，避免同名覆盖。
 * 同上：服务于一次性归档；长期驻留的文件夹请用带 ` (n)` 去重的可读命名。
 */
export function archiveFilename(title: string, docId: string): string {
  const slug = sanitizeFilename(title || 'untitled')
  const shortId = docId.replace(/-/g, '').slice(0, 12)
  return `${slug}--${shortId}.md`
}

/**
 * 归档一层目录：首标签（插入序）sanitize 后作目录名；无标签 → untagged。
 * 标签里的 / \ 先换成连字符，避免意外嵌套。
 */
export function archiveDirName(tags: readonly string[]): string {
  const first = tags[0]?.trim()
  if (!first) return ARCHIVE_UNTAGGED_DIR
  const slug = sanitizeFilename(first.replace(/[\\/]/g, '-'), 64)
  return slug || ARCHIVE_UNTAGGED_DIR
}

/**
 * 归档相对路径：`<目录>/<slug>--<id>.md`。
 *
 * **只用于「一次性输出」的归档场景**（RFC 0007 S2）：
 *   - 远端归档 `sync/archivePush.ts`（S3 / WebDAV / LocalFS）
 *   - 整库 zip `services/docExport.ts`（`GET /export/archive`）
 *   - 兜底导出 `services/autoExport.ts`（`GET /api/v1/sync/export/markdown`）
 *
 * 这些场景的产物是**一次性的**（下载走、传走就完了），所以：
 *   ① 用 `<首标签>` 分目录 —— 人类查看时好找
 *   ② 用 `<id12>` 后缀 —— 同名文档不会互相覆盖
 *
 * **不要**把它用于**长期驻留**的文件夹。投影（`services/shadowMarkdown.ts`）早先借它
 * 生成路径，代价是用户在自己的文件夹里看到 `我的笔记--a1b2c3d4e5f6.md`，
 * 而且标题一变路径就跟着搬。投影现在有自己的命名（`projectionSlug` + 用户可改），
 * 见 RFC 0007 D2。
 */
export function archiveRelPath(title: string, docId: string, tags: readonly string[]): string {
  return `${archiveDirName(tags)}/${archiveFilename(title, docId)}`
}

export function buildArchiveManifest(opts: {
  adapter: string
  files: ArchiveManifest['files']
  media?: string[]
}): ArchiveManifest {
  return {
    app: 'notefast',
    kind: 'markdown-archive',
    version: 1,
    updatedAt: new Date().toISOString(),
    adapter: opts.adapter,
    files: opts.files,
    media: opts.media?.length ? opts.media : undefined,
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

/** 计算应删除的陈旧 media 相对键：上一份有、当前文档不再引用 */
export function staleArchiveMedia(
  previous: ArchiveManifest | null,
  current: ArchiveManifest,
): string[] {
  if (!previous?.media) return []
  const keep = new Set(current.media ?? [])
  return previous.media.filter((key) => !keep.has(key))
}
