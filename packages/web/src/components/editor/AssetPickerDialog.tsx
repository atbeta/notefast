/**
 * 资源库图片选择器 — 编辑器「从资源库插入」用
 *
 * 拉取 GET /assets 网格展示；单选即回调 onPick(asset:sha) 并关闭。
 * portal + 遮罩 + Esc，形态对齐 ConfirmDialog。
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ImageIcon, Loader2, X } from 'lucide-react'
import { api } from '../../hooks/useAPI'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { ListRowsSkeleton, Tooltip } from '../ui'

interface AssetListItem {
  id: string
  mime: string
  size: number
  created_at: string
  remote: boolean
  referenced: boolean
}

interface AssetPickerDialogProps {
  open: boolean
  onClose: () => void
  /** 选中资源的稳定引用，形如 asset:<sha256> */
  onPick: (ref: string) => void
}

export default function AssetPickerDialog({ open, onClose, onPick }: AssetPickerDialogProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  useFocusTrap(containerRef, open)

  const [items, setItems] = useState<AssetListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setItems(null)
    setError(null)
    api
      .get<{ items: AssetListItem[]; total: number }>('/assets?limit=100')
      .then((res) => {
        if (cancelled) return
        setItems(Array.isArray(res?.items) ? res.items : [])
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setItems([])
      })
    return () => { cancelled = true }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-dialog flex items-center justify-center p-4">
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="asset-picker-title"
        className="relative bg-card rounded-lg border border-border shadow-floating shadow-black/40 w-full max-w-lg max-h-[min(70vh,560px)] flex flex-col animate-fade-in"
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border/60 shrink-0">
          <h3 id="asset-picker-title" className="text-[15px] font-medium text-foreground tracking-tight">
            {t('editorToolbar.pickFromLibrary')}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="btn-icon-ghost text-muted-foreground hover:text-foreground"
            aria-label={t('common.close')}
          >
            <X className="w-4 h-4" strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          {items === null ? (
            <div className="py-2">
              <ListRowsSkeleton rows={4} />
            </div>
          ) : error ? (
            <div className="px-2 py-10 text-center space-y-2">
              <p className="text-[13px] text-destructive">{t('editorToolbar.assetPickerLoadFailed')}</p>
              <p className="text-[12px] text-muted-foreground">{error}</p>
            </div>
          ) : items.length === 0 ? (
            <div className="px-2 py-12 flex flex-col items-center text-center">
              <div className="empty-icon-tile mb-3">
                <ImageIcon className="w-5 h-5" />
              </div>
              <p className="text-[14px] font-medium text-foreground mb-1">
                {t('editorToolbar.assetPickerEmptyTitle')}
              </p>
              <p className="text-[12.5px] text-muted-foreground max-w-xs leading-relaxed">
                {t('editorToolbar.assetPickerEmptyDesc')}
              </p>
            </div>
          ) : (
            <ul className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {items.map((item) => (
                <li key={item.id}>
                  <Tooltip label={item.id.slice(0, 12)} className="w-full">
                    <button
                      type="button"
                      onClick={() => onPick(`asset:${item.id}`)}
                      className="w-full aspect-square rounded-md border border-border/60 bg-muted/40 overflow-hidden hover:border-primary/50 hover:ring-1 hover:ring-primary/30 transition-all "
                    >
                      <img
                        src={`/api/v1/assets/${item.id}`}
                        alt=""
                        loading="lazy"
                        className="w-full h-full object-contain"
                      />
                    </button>
                  </Tooltip>
                </li>
              ))}
            </ul>
          )}
        </div>

        {items === null && (
          <div className="sr-only" aria-live="polite">
            <Loader2 className="w-3 h-3 animate-spin" />
            {t('common.loading')}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
