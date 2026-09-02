/**
 * 编辑器图片操作弹层 — 点击图片预览后弹出
 *
 * 用户点击图片的意图是「替换 / 查看」，不是编辑 asset:<hash> 源码。
 * 菜单：替换图片（上传）/ 从资源库选择 / 查看原图（lightbox）。
 * 替换只改 src、保留原 alt；写回走 onReplace（CM transaction，光标不动）。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Images, Loader2, Upload, Eye, Code2 } from 'lucide-react'
import { EDIT_IMAGE_EVENT, type EditImageDetail } from '../../lib/editImage'
import { usePopoverDismiss } from '../../hooks/usePopoverDismiss'
import { useToast } from '../ui'
import AssetPickerDialog from './AssetPickerDialog'
import ImageLightbox from '../ImageLightbox'

interface ImageEditPopoverProps {
  /** 上传图片文件，返回 asset:<sha256> 引用；失败抛错 */
  onUploadFile: (file: File) => Promise<string>
  /** 替换图片行 markdown：保留 alt，只换 src */
  onReplace: (from: number, to: number, ref: string, alt: string) => void
  /** 编辑源码：光标移到图片行（预览收起露出 markdown） */
  onEditSource: (from: number) => void
}

/** asset:<sha256> 稳定引用 → API 路径（与 BlockRenderer / imagePreview 一致） */
function resolveSrc(raw: string): string {
  return raw.startsWith('asset:') ? `/api/v1/assets/${raw.slice(6)}` : raw
}

export default function ImageEditPopover({ onUploadFile, onReplace, onEditSource }: ImageEditPopoverProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const menuRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [session, setSession] = useState<EditImageDetail | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [viewing, setViewing] = useState(false)

  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<EditImageDetail>).detail
      if (!d) return
      setSession(d)
      setUploading(false)
      setPickerOpen(false)
      setViewing(false)
      const menuW = 180
      const left = Math.max(8, Math.min(d.rect.left, window.innerWidth - menuW - 8))
      // 先按图片下方定位；useLayoutEffect 里测量真实高度后决定是否翻到上方
      setPos({ top: d.rect.top + d.rect.height + 6, left })
    }
    window.addEventListener(EDIT_IMAGE_EVENT, handler)
    return () => window.removeEventListener(EDIT_IMAGE_EVENT, handler)
  }, [])

  // 弹层定位修正：图片贴近视口底部时，下方放不下菜单 → 翻到图片上方。
  // useLayoutEffect 在绘制前测量真实高度，避免估算偏差导致溢出或误翻。
  useLayoutEffect(() => {
    if (!session || !pos) return
    const el = menuRef.current
    if (!el) return
    const h = el.offsetHeight
    const GAP = 6
    const below = session.rect.top + session.rect.height + GAP
    const above = session.rect.top - h - GAP
    let top = below
    if (below + h > window.innerHeight && above > 8) top = above
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8))
    if (top !== pos.top) setPos((p) => (p ? { ...p, top } : p))
  }, [session, pos])

  const close = useCallback(() => setSession(null), [])
  usePopoverDismiss(!!session, { onClose: close }, menuRef)

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file || !session || uploading) return
      setUploading(true)
      try {
        const ref = await onUploadFile(file)
        onReplace(session.from, session.to, ref, session.alt)
        setSession(null)
      } catch (e) {
        toast.error({
          title: t('imageUploader.uploadFailed'),
          description: e instanceof Error ? e.message : String(e),
        })
        setUploading(false)
      }
    },
    [session, uploading, onUploadFile, onReplace, toast, t],
  )

  if (!session || !pos) return null

  const resolvedSrc = resolveSrc(session.rawSrc)

  return createPortal(
    <>
      <div
        ref={menuRef}
        role="menu"
        aria-label={t('editorToolbar.imageActions')}
        className="fixed z-popover min-w-[180px] py-1 rounded-lg border border-border bg-popover text-popover-foreground shadow-floating animate-fade-in"
        style={{ top: pos.top, left: pos.left }}
      >
        <button
          type="button"
          role="menuitem"
          disabled={uploading}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 text-base text-left text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? (
            <Loader2 className="w-3.5 h-3.5 text-muted-foreground animate-spin" strokeWidth={1.75} />
          ) : (
            <Upload className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.75} />
          )}
          <span>{uploading ? t('editorToolbar.uploading') : t('editorToolbar.replaceImage')}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={uploading}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 text-base text-left text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => setPickerOpen(true)}
        >
          <Images className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.75} />
          <span>{t('editorToolbar.fromLibrary')}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          className="w-full flex items-center gap-2 px-2.5 py-1.5 text-base text-left text-foreground hover:bg-accent transition-colors"
          onClick={() => setViewing(true)}
        >
          <Eye className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.75} />
          <span>{t('editorToolbar.viewOriginal')}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          className="w-full flex items-center gap-2 px-2.5 py-1.5 text-base text-left text-foreground hover:bg-accent transition-colors"
          onClick={() => {
            onEditSource(session.from)
            setSession(null)
          }}
        >
          <Code2 className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.75} />
          <span>{t('editorToolbar.editSource')}</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void handleFile(f)
          }}
        />
      </div>

      <AssetPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(ref) => {
          onReplace(session.from, session.to, ref, session.alt)
          setSession(null)
        }}
      />

      {viewing && (
        <ImageLightbox src={resolvedSrc} alt={session.alt} onClose={() => setViewing(false)} />
      )}
    </>,
    document.body,
  )
}