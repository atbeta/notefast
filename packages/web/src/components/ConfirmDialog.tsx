import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useFocusTrap } from '../hooks/useFocusTrap'

type Tone = 'destructive' | 'info'

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  /** 图标 + 配色：destructive = 红色三角警告；info = 中性提示 */
  tone?: Tone
  /**
   * 兼容旧用法：tone='destructive' 的别名。
   * @deprecated 直接传 tone 即可。
   */
  destructive?: boolean
  /**
   * 进行中状态：禁用确认按钮 + Enter 二次触发防护 + 文案可换（如「删除中…」）
   * 比外层用 useState 切换 confirmLabel 更安全。
   */
  busy?: boolean
  busyLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  tone,
  destructive,
  busy = false,
  busyLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  useFocusTrap(containerRef, open)

  const effectiveTone: Tone = tone ?? (destructive ? 'destructive' : 'info')

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel()
      // Enter 二次触发防护：busy 时不响应全局 Enter 触发的 confirm
      if (e.key === 'Enter' && busy) {
        const active = document.activeElement as HTMLElement | null
        // 文本域/input 内部允许 Enter 换行/提交，仅拦截「焦点不在可输入元素」的 Enter
        if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) return
        e.preventDefault()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onCancel, busy])

  if (!open) return null

  const label = busy && busyLabel ? busyLabel : confirmLabel ?? t('common.confirm')

  // portal 到 body：避免被带 mask/overflow 的祖先（如侧栏 scroll-fade 最近文档区）
  // 裁剪，导致全屏弹窗不可见
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-[2px] transition-opacity" onClick={busy ? undefined : onCancel} aria-hidden="true" />
      <div
        ref={containerRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        className="relative bg-card rounded-lg shadow-2xl shadow-black/40 max-w-sm w-full mx-4 p-6 sm:p-7 animate-fade-in"
      >
        <div className="flex items-start gap-3.5 mb-6">
          {effectiveTone === 'destructive' ? (
            <div className="w-8 h-8 rounded-md bg-destructive/10 flex items-center justify-center shrink-0 mt-0.5">
              <AlertTriangle className="w-4 h-4 text-destructive/90" strokeWidth={2} />
            </div>
          ) : (
            <div className="w-8 h-8 rounded-md bg-secondary flex items-center justify-center shrink-0 mt-0.5">
              <Info className="w-4 h-4 text-muted-foreground" strokeWidth={2} />
            </div>
          )}
          <div className="min-w-0">
            <h3 id="confirm-dialog-title" className="text-[15px] font-medium text-foreground tracking-tight">
              {title}
            </h3>
            <p id="confirm-dialog-message" className="text-[13.5px] text-muted-foreground/80 mt-1.5 leading-relaxed">
              {message}
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2.5">
          <button
            type="button"
            onClick={busy ? undefined : onCancel}
            disabled={busy}
            className="px-3.5 py-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground bg-transparent hover:bg-secondary/60 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t('confirm.cancel')}
          </button>
          <button
            type="button"
            onClick={busy ? undefined : onConfirm}
            disabled={busy}
            aria-busy={busy || undefined}
            className={`px-3.5 py-1.5 text-[13px] font-medium rounded-md transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed ${
              effectiveTone === 'destructive'
                ? 'bg-destructive/90 text-destructive-foreground hover:bg-destructive shadow-sm'
                : 'bg-foreground text-background shadow-sm hover:bg-foreground/90'
            }`}
          >
            {label}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}