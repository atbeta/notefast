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
