import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'

interface ImageLightboxProps {
  src: string
  alt?: string
  onClose: () => void
}

/**
 * 图片放大查看（lightbox）：fixed 全屏遮罩 + 居中大图，点击遮罩/图片/关闭钮退出。
 * 与资源页预览同视觉语言（resources.tsx），供阅读页等任意图片场景复用。
 */
export default function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  const { t } = useTranslation()
  return createPortal(
    <div className="fixed inset-0 z-[90] flex flex-col">
      <div
        className="absolute inset-0 bg-black/75 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={alt || t('block.previewImage')}
        className="relative flex-1 flex flex-col min-h-0"
      >
        <div className="flex items-center justify-end px-4 py-3 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-white/80 hover:text-white hover:bg-white/10 transition-colors"
            aria-label={t('common.close')}
          >
            <X className="w-4 h-4" strokeWidth={1.75} />
          </button>
        </div>
        <div
          className="flex-1 min-h-0 flex items-center justify-center px-4 pb-6 cursor-zoom-out"
          onClick={onClose}
        >
          <img
            src={src}
            alt={alt ?? ''}
            className="max-w-full max-h-full object-contain rounded-md shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      </div>
    </div>,
    document.body,
  )
}
