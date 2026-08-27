/**
 * 文档 PDF 导出：阅读页已有 `@media print` 样式（只留正文）。
 * 菜单入口打开系统打印对话框，再存储为 PDF；默认文件名用笔记标题。
 */

export const EXPORT_PDF_PARAM = 'export'
export const EXPORT_PDF_VALUE = 'pdf'

export function docExportPdfPath(docId: string): string {
  return `/doc/${docId}?${EXPORT_PDF_PARAM}=${EXPORT_PDF_VALUE}`
}

export function hasExportPdfParam(params: URLSearchParams): boolean {
  return params.get(EXPORT_PDF_PARAM) === EXPORT_PDF_VALUE
}

export function stripExportPdfParam(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params)
  next.delete(EXPORT_PDF_PARAM)
  return next
}

/** 打开打印对话框；afterprint 后恢复原页面标题 */
export function printReadingDocAsPdf(title?: string): void {
  const prevTitle = document.title
  const next = title?.trim()
  if (next) document.title = next
  const restore = () => {
    document.title = prevTitle
    window.removeEventListener('afterprint', restore)
  }
  window.addEventListener('afterprint', restore)
  window.print()
}

/**
 * 打印一律浅色纸面。阅读页颜色走 data-theme token，暗色主题下直接 print
 * 会把深色块印进 PDF；导出 PDF 与系统打印共用 beforeprint。
 */
export function installPrintDocumentHooks(): void {
  const root = document.documentElement
  let prevTheme: string | null = null
  window.addEventListener('beforeprint', () => {
    prevTheme = root.getAttribute('data-theme')
    root.setAttribute('data-theme', 'light')
  })
  window.addEventListener('afterprint', () => {
    if (prevTheme) root.setAttribute('data-theme', prevTheme)
    prevTheme = null
  })
}
