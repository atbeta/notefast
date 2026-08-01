import { useState, useCallback, useMemo } from 'react'
import { fetchWithAuth } from './useAPI'
import { useToast } from '../components/ui'

interface UseImageUploaderOpts {
  insertAtCursor: (text: string, opts?: { cursorOffset?: number; selectStart?: number }) => void
}

export function useImageUploader({ insertAtCursor }: UseImageUploaderOpts) {
  const [uploading, setUploading] = useState(false)
  const toast = useToast()

  const uploadImage = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/') || uploading) return
      setUploading(true)
      try {
        const res = await fetchWithAuth('/assets', {
          method: 'POST',
          headers: { 'Content-Type': file.type },
          body: file,
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({ message: res.statusText }))
          throw new Error(err.message || `HTTP ${res.status}`)
        }
        const data = (await res.json()) as { ref: string }
        const alt = file.name.replace(/\.[a-z0-9]+$/i, '') || 'image'
        insertAtCursor(`\n![${alt}](${data.ref})\n`)
      } catch (e) {
        toast.error({
          title: '图片上传失败',
          description: e instanceof Error ? e.message : String(e),
        })
      } finally {
        setUploading(false)
      }
    },
    [uploading, insertAtCursor, toast],
  )

  // 粘贴 / 拖拽的图片文件由编辑器（CodeMirror domEventHandlers）转交 uploadImage
  return useMemo(() => ({ uploading, uploadImage }), [uploading, uploadImage])
}
