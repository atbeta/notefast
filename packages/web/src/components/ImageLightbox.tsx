import { useEffect, useState, type ImgHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Check, Copy, X } from 'lucide-react'
import MediaZoomView from './MediaZoomView'
import { Tooltip, useToast } from './ui'

interface ImageLightboxProps {
  onClose: () => void
  /** 图片地址；与 children 二选一 */
  src?: string
  alt?: string
  /** 自定义媒体（如 mermaid SVG），传入时不渲染 <img> */
  children?: ReactNode
  /** 顶栏左侧（资源库文件信息等） */
  headerStart?: ReactNode
  /** 关闭钮左侧的额外操作（删除等） */
  headerActions?: ReactNode
  /** 画布下方页脚（引用列表等） */
  footer?: ReactNode
  /** 媒体内容变化时重测自然尺寸（mermaid svg 源等） */
  measureKey?: string
}

/**
 * 统一媒体灯箱：阅读页图片、Mermaid、资源库预览共用。
 * 适配视口铺满后可缩放/平移；点遮罩 / 关闭钮 / Esc 退出（点内容不关，避免和拖动手势冲突）。
 */
export default function ImageLightbox({
  onClose,
  src,
  alt,
  children,
  headerStart,
  headerActions,
  footer,
  measureKey,
}: ImageLightboxProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const label = alt || t('block.previewImage')
  const [copied, setCopied] = useState(false)

  /**
   * 复制图片到剪贴板（原生壳 WKWebView 无右键菜单，阅读页图片此前无法复制）。
   * fetch 同源地址（assets API 带 cookie 鉴权 / 公开页走公开端点）拿 blob 写
   * ClipboardItem；失败（权限/不支持）toast 提示而不是静默。
   */
  const copyImage = async () => {
    if (!src) return
    try {
      const res = await fetch(src)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })])
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error({ title: t('lightbox.copyImageFailed') })
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  const media = children ?? (
    <img src={src} alt={alt ?? ''} draggable={false} />
  )

  return createPortal(
    <div className="fixed inset-0 z-dialog flex flex-col">
      <div
        className="absolute inset-0 bg-black/75 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="relative z-[1] flex-1 flex flex-col min-h-0"
      >
        <div className="relative z-header flex items-center justify-between gap-3 px-4 py-3 shrink-0 pointer-events-auto">
          <div className="min-w-0 flex-1">{headerStart}</div>
          <div className="flex items-center gap-1.5 shrink-0">
            {headerActions}
            {src && !children && (
              <Tooltip label={copied ? t('lightbox.copyImageDone') : t('lightbox.copyImage')}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    void copyImage()
                  }}
                  className="inline-flex items-center justify-center w-8 h-8 rounded-md text-white/80 hover:text-white hover:bg-white/10 transition-colors"
                  aria-label={copied ? t('lightbox.copyImageDone') : t('lightbox.copyImage')}
                >
                  {copied ? (
                    <Check className="w-4 h-4" strokeWidth={1.75} />
                  ) : (
                    <Copy className="w-4 h-4" strokeWidth={1.75} />
                  )}
                </button>
              </Tooltip>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onClose()
              }}
              className="inline-flex items-center justify-center w-8 h-8 rounded-md text-white/80 hover:text-white hover:bg-white/10 transition-colors"
              aria-label={t('common.close')}
            >
              <X className="w-4 h-4" strokeWidth={1.75} />
            </button>
          </div>
        </div>
        <div className="relative z-sticky flex-1 min-h-0">
          <MediaZoomView measureKey={measureKey ?? src ?? label} onBackgroundClick={onClose}>
            {media}
          </MediaZoomView>
        </div>
        {footer ? (
          <div className="relative z-header shrink-0 px-4 pb-4" onClick={(e) => e.stopPropagation()}>
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}

/** 点击图片打开统一灯箱（聊天 Markdown / 附件等入口） */
export function LightboxImg({
  className,
  onClick,
  alt,
  ...props
}: ImgHTMLAttributes<HTMLImageElement>) {
  const [open, setOpen] = useState(false)
  const src = typeof props.src === 'string' ? props.src : undefined
  return (
    <>
      <img
        {...props}
        alt={alt ?? ''}
        className={`${className ?? ''} cursor-zoom-in`}
        onClick={(e) => {
          onClick?.(e)
          if (!e.defaultPrevented && src) setOpen(true)
        }}
      />
      {open && src ? <ImageLightbox src={src} alt={alt} onClose={() => setOpen(false)} /> : null}
    </>
  )
}
