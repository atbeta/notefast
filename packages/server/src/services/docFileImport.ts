/**
 * 从「文件正文」创建文档（MCP create_doc_from_file / REST multipart 共用）
 *
 * 与 create_doc 的差异：
 * - 面向整文件导入：规范化换行 / 常见 LLM 转义损坏
 * - 标题可从 filename / 首个 H1 推断
 * - 支持 upload_id 暂存（大文件分块）
 */

import type { getDb } from '../db'
import {
  EmptyMarkdownError,
  insertDocFromMarkdown,
  type InsertDocFromMarkdownResult,
} from './docImport'
import {
  MAX_MARKDOWN_IMPORT_BYTES,
  takeStagedMarkdown,
} from './markdownStage'

type Db = ReturnType<typeof getDb>

export class DocFileImportError extends Error {
  constructor(
    message: string,
    public code: 'invalid_params' | 'not_found' = 'invalid_params',
  ) {
    super(message)
    this.name = 'DocFileImportError'
  }
}

/**
 * 规范化文件正文：
 * - 去 BOM、统一换行
 * - 若几乎无真实换行、却大量字面量 \\n（模型转义损坏），还原为真换行
 */
export function normalizeMarkdownFileContent(raw: string): string {
  let s = raw.replace(/^\uFEFF/, '')
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const realNewlines = (s.match(/\n/g) ?? []).length
  const literalNewlines = (s.match(/\\n/g) ?? []).length
  if (realNewlines < 2 && literalNewlines >= 3) {
    s = s.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
  }
  return s
}

export function titleFromFilename(filename: string | undefined | null): string | null {
  if (!filename) return null
  const base = filename.split(/[/\\]/).pop()?.trim() || ''
  if (!base) return null
  const noExt = base.replace(/\.(md|markdown|mdown|mkd|txt|docx)$/i, '').trim()
  return noExt || null
}

export function extractTitleFromMarkdown(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)/m)
  return match ? match[1]!.trim() : null
}

export function resolveImportTitle(opts: {
  title?: string
  filename?: string
  markdown: string
}): string {
  const explicit = opts.title?.trim()
  if (explicit) return explicit.slice(0, 500)
  return (
    extractTitleFromMarkdown(opts.markdown)
    || titleFromFilename(opts.filename)
    || '未命名文档'
  ).slice(0, 500)
}

export interface CreateDocFromFileOptions {
  notebookId: string
  /** 与 upload_id 二选一 */
  content?: string
  /** 由 notefast_stage_markdown 返回 */
  uploadId?: string
  title?: string
  filename?: string
  status?: 'note' | 'inbox'
  tags?: string[]
}

export interface CreateDocFromFileResult extends InsertDocFromMarkdownResult {
  title: string
  markdown: string
}

/** 解析 content / upload_id → 规范化正文 */
export function resolveMarkdownFromFileInput(opts: {
  content?: string
  uploadId?: string
}): string {
  const hasContent = typeof opts.content === 'string' && opts.content.length > 0
  const hasUpload = typeof opts.uploadId === 'string' && opts.uploadId.trim().length > 0
  if (hasContent === hasUpload) {
    throw new DocFileImportError('必须且只能提供 content 或 upload_id 之一')
  }

  let raw: string
  if (hasUpload) {
    const taken = takeStagedMarkdown(opts.uploadId!.trim())
    if (taken == null) {
      throw new DocFileImportError(`upload_id 不存在或已过期：${opts.uploadId}`, 'not_found')
    }
    raw = taken
  } else {
    raw = opts.content!
  }

  const bytes = Buffer.byteLength(raw, 'utf8')
  if (bytes > MAX_MARKDOWN_IMPORT_BYTES) {
    throw new DocFileImportError(`内容不得超过 ${MAX_MARKDOWN_IMPORT_BYTES} 字节`)
  }
  if (bytes === 0) {
    throw new DocFileImportError('文件内容为空')
  }

  const markdown = normalizeMarkdownFileContent(raw)
  if (!markdown.trim()) {
    throw new DocFileImportError('文件内容为空')
  }
  return markdown
}

export function createDocFromMarkdownFile(
  db: Db,
  opts: CreateDocFromFileOptions,
): CreateDocFromFileResult {
  const markdown = resolveMarkdownFromFileInput({
    content: opts.content,
    uploadId: opts.uploadId,
  })
  const title = resolveImportTitle({
    title: opts.title,
    filename: opts.filename,
    markdown,
  })

  try {
    const result = insertDocFromMarkdown(db, {
      notebookId: opts.notebookId,
      title,
      markdown,
      status: opts.status,
      tags: opts.tags,
      rejectEmpty: true,
    })
    return { ...result, title, markdown }
  } catch (e) {
    if (e instanceof EmptyMarkdownError) {
      throw new DocFileImportError(e.message)
    }
    throw e
  }
}
