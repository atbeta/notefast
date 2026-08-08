import { useState, useCallback, useMemo } from 'react'
import i18next from 'i18next'
import { getStoredToken } from './useAPI'
import { useToast } from '../components/ui'

interface UseImageUploaderOpts {
  insertAtCursor: (text: string, opts?: { cursorOffset?: number; selectStart?: number }) => void
}

interface UploadState {
  /** 上传中 */
  uploading: boolean
  /** 0-100 进度；0 表示未开始 / 完成 */
  progress: number
}

/**
 * 图片上传 hook
 *
 * 用 XMLHttpRequest 而不是 fetch：fetch 没有 upload progress 事件，
 * 而 XHR.upload.onprogress 直接给 loaded / total，能驱动进度环。
 * 同源策略下 onprogress 在跨域时不可见（需要 CORS 暴露 header），
 * 当前 /api/v1/assets 默认 same-origin 所以总是能拿到。
 */
export function useImageUploader({ insertAtCursor }: UseImageUploaderOpts) {
  const [{ uploading, progress }, setUpload] = useState<UploadState>({
    uploading: false,
    progress: 0,
  })
  const toast = useToast()

  const uploadImage = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/') || uploading) return
      setUpload({ uploading: true, progress: 0 })

      const token = getStoredToken()
      const headers: Record<string, string> = { 'Content-Type': file.type }
      if (token) headers.Authorization = `Bearer ***`

      try {
        const result = await new Promise<{ ref: string }>((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          xhr.open('POST', '/api/v1/assets')
          for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && e.total > 0) {
              const pct = Math.min(99, Math.round((e.loaded / e.total) * 100))
              setUpload({ uploading: true, progress: pct })
            }
          }
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                resolve(JSON.parse(xhr.responseText) as { ref: string })
              } catch {
                reject(new Error('Invalid response'))
              }
            } else {
              let msg = xhr.statusText
              try {
                const body = JSON.parse(xhr.responseText) as { message?: string }
                if (body?.message) msg = body.message
              } catch { /* ignore parse error */ }
              reject(new Error(msg || `HTTP ${xhr.status}`))
            }
          }
          xhr.onerror = () => reject(new Error('Network error'))
          xhr.onabort = () => reject(new Error('Aborted'))
          xhr.send(file)
        })

        const alt = file.name.replace(/\.[a-z0-9]+$/i, '') || 'image'
        insertAtCursor(`\n![${alt}](${result.ref})\n`)
        setUpload({ uploading: false, progress: 100 })
        // 100% 一帧后归零，让下一次上传能从 0 开始显示（避免按钮残留进度）
        setTimeout(() => setUpload((s) => (s.progress === 100 ? { uploading: false, progress: 0 } : s)), 600)
      } catch (e) {
        toast.error({
          title: i18next.t('imageUploader.uploadFailed'),
          description: e instanceof Error ? e.message : String(e),
        })
        setUpload({ uploading: false, progress: 0 })
      }
    },
    [uploading, insertAtCursor, toast],
  )

  return useMemo(() => ({ uploading, progress, uploadImage }), [uploading, progress, uploadImage])
}