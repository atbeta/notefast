import { useEffect, useRef } from 'react'
import { AlertTriangle } from 'lucide-react'

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
  confirmLabel = '确认',
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40" onClick={onCancel} />
      <div className="relative bg-card border border-border rounded-xl shadow-lg max-w-sm w-full mx-4 p-6 animate-fade-in">
        <div className="flex items-start gap-3 mb-4">
          {destructive && (
            <div className="w-9 h-9 rounded-full bg-destructive/10 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-5 h-5 text-destructive" />
            </div>
          )}
          <div>
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <p className="text-sm text-muted-foreground mt-1">{message}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="px-3 py-1.5 text-sm font-medium text-foreground bg-secondary hover:bg-accent rounded-lg transition-colors"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-all active:scale-[0.98] ${
              destructive
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : 'bg-ink text-ink-foreground border border-ink hover:bg-ink-hover hover:border-ink-hover'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
