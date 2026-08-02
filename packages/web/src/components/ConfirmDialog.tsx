import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation()
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (open) cancelRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onCancel])

  if (!open) return null

  // portal 到 body：避免被带 mask/overflow 的祖先（如侧栏 scroll-fade 最近文档区）
  // 裁剪，导致全屏弹窗不可见
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-[2px] transition-opacity" onClick={onCancel} />
      {/* 移除粗重边框，依靠阴影和色阶差异建立纵深；增加内边距带来呼吸感 */}
      <div className="relative bg-card rounded-lg shadow-2xl shadow-black/40 max-w-sm w-full mx-4 p-6 sm:p-7 animate-fade-in">
        <div className="flex items-start gap-3.5 mb-6">
          {destructive && (
            <div className="w-8 h-8 rounded-md bg-destructive/10 flex items-center justify-center shrink-0 mt-0.5">
              <AlertTriangle className="w-4 h-4 text-destructive/90" strokeWidth={2} />
            </div>
          )}
          <div>
            <h3 className="text-[15px] font-medium text-foreground tracking-tight">{title}</h3>
            <p className="text-[13.5px] text-muted-foreground/80 mt-1.5 leading-relaxed">{message}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2.5">
          {/* 取消按钮使用幽灵按钮样式，降低视觉噪音 */}
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="px-3.5 py-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground bg-transparent hover:bg-secondary/60 rounded-md transition-colors"
          >
            {t('confirm.cancel')}
          </button>
          <button
            onClick={onConfirm}
            className={`px-3.5 py-1.5 text-[13px] font-medium rounded-md transition-all active:scale-[0.98] ${
              destructive
                ? 'bg-destructive/90 text-destructive-foreground hover:bg-destructive shadow-sm'
                : 'bg-foreground text-background shadow-sm hover:bg-foreground/90'
            }`}
          >
            {confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
