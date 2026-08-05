import { fetchWithAuth } from '../hooks/useAPI'
import { isTauriShell } from '../hooks/useShell'

/**
 * 浏览器文件下载辅助（单文档导出等）
 */

/** 从 Content-Disposition 解析文件名（优先 filename*） */
export function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null
  const star = /filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;]+)/i.exec(header)
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''))
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*"((?:\\.|[^"])*)"|filename\s*=\s*([^;]+)/i.exec(header)
  if (plain) {
    const raw = (plain[1] ?? plain[2] ?? '').trim().replace(/^"|"$/g, '')
    return raw || null
  }
  return null
}

/** 触发一次浏览器「另存为」下载 */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 延迟 revoke，避免部分浏览器尚未开始下载
  setTimeout(() => URL.revokeObjectURL(url), 2_000)
}

/**
 * Tauri 壳：弹系统「另存为」对话框选路径并写文件，返回保存路径（用户取消返回 null）。
 * 避免 WebView2 静默下载到 Downloads——用户看得见保存位置。
 */
export async function saveBlobViaTauriDialog(blob: Blob, filename: string): Promise<string | null> {
  const [{ save }, { writeFile }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ])
  const path = await save({ defaultPath: filename })
  if (!path) return null
  const data = new Uint8Array(await blob.arrayBuffer())
  await writeFile(path, data)
  return path
}

/** 导出交付结果：浏览器=下载；Tauri 壳=另存为对话框 */
export interface ExportDelivery {
  mode: 'downloaded' | 'saved' | 'cancelled'
  savedPath?: string
}

/** 按壳形态交付导出文件（浏览器触发下载；Tauri 弹另存为）。UI 层据此 toast。 */
export async function deliverExport(blob: Blob, filename: string): Promise<ExportDelivery> {
  if (isTauriShell()) {
    const savedPath = await saveBlobViaTauriDialog(blob, filename)
    return savedPath ? { mode: 'saved', savedPath } : { mode: 'cancelled' }
  }
  triggerBlobDownload(blob, filename)
  return { mode: 'downloaded' }
}

/** 拉取单文档导出文件（.md 或含图 zip），解析文件名。失败抛错。 */
export async function fetchDocExportFile(docId: string, title: string): Promise<{ blob: Blob; filename: string }> {
  const res = await fetchWithAuth(`/docs/${docId}/export/file`)
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null)
    throw new Error((body as { message?: string } | null)?.message || `HTTP ${res.status}`)
  }
  const blob = await res.blob()
  const filename =
    parseContentDispositionFilename(res.headers.get('Content-Disposition'))
    || (blob.type.includes('zip') ? `${title}.zip` : `${title}.md`)
  return { blob, filename }
}
