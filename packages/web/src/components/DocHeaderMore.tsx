/**
 * 文档页顶栏溢出菜单：导出 / 关联图谱 / 删除。
 * 阅读现场（编辑、缩放、加宽、演示）和会变的分享状态留在外面。
 */

import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Download, Loader2, MoreHorizontal, Network, Trash2 } from 'lucide-react'
import { usePopoverDismiss } from '../hooks/usePopoverDismiss'
import { Tooltip } from './ui'

const iconCls = 'w-3.5 h-3.5 shrink-0'
const itemCls = 'w-full flex items-center gap-2 px-2.5 py-1.5 text-[13px] text-left text-foreground hover:bg-accent transition-colors disabled:opacity-40'

interface DocHeaderMoreProps {
  docId: string
  exporting: boolean
  disabled?: boolean
  onExport: () => void
  onDelete: () => void
}

export default function DocHeaderMore({
  docId,
  exporting,
  disabled,
  onExport,
  onDelete,
}: DocHeaderMoreProps) {
  const { t } = useTranslation()
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; openUp: boolean } | null>(null)

  const close = useCallback(() => setOpen(false), [])

  const placeMenu = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const panelW = 200
    const approxH = 140
    const pad = 8
    const openUp = r.bottom + approxH > window.innerHeight - pad && r.top > approxH
    let left = r.right - panelW
    left = Math.max(pad, Math.min(left, window.innerWidth - panelW - pad))
    setPos({ top: openUp ? r.top - pad : r.bottom + 4, left, openUp })
  }, [])

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    placeMenu()
  }, [open, placeMenu])

  usePopoverDismiss(
    open,
    {
      onClose: close,
      closeOnScroll: true,
      closeOnResize: true,
      onEscape: (e) => {
        e.preventDefault()
        e.stopPropagation()
        close()
      },
    },
    triggerRef,
    panelRef,
  )

  return (
    <>
      <Tooltip label={t('docActions.moreActionsTooltip')}>
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label={t('docActions.menuLabel')}
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          className={`inline-flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
            open
              ? 'text-foreground bg-accent'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent'
          } disabled:opacity-40`}
        >
          <MoreHorizontal className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </Tooltip>

      {open && pos && createPortal(
        <div
          ref={panelRef}
          id={menuId}
          role="menu"
          aria-label={t('docActions.menuLabel')}
          className="fixed z-popover min-w-[180px] max-w-[240px] py-1 rounded-lg border border-border bg-popover text-popover-foreground shadow-floating animate-fade-in"
          style={{
            top: pos.openUp ? undefined : pos.top,
            bottom: pos.openUp ? window.innerHeight - pos.top : undefined,
            left: pos.left,
          }}
        >
          <button
            type="button"
            role="menuitem"
            disabled={exporting || disabled}
            onClick={() => {
              close()
              onExport()
            }}
            className={itemCls}
          >
            {exporting
              ? <Loader2 className={`${iconCls} animate-spin`} strokeWidth={1.75} />
              : <Download className={iconCls} strokeWidth={1.75} />}
            <span>{t('doc.exportDoc')}</span>
          </button>
          <Link
            role="menuitem"
            to={`/graph?mode=docs&center=${encodeURIComponent(docId)}&center_type=doc`}
            onClick={close}
            className={itemCls}
          >
            <Network className={iconCls} strokeWidth={1.75} />
            <span>{t('doc.viewGraph')}</span>
          </Link>
          <div className="my-1 mx-2 h-px bg-border/80" role="separator" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close()
              onDelete()
            }}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[13px] text-left text-destructive hover:bg-destructive/10 transition-colors"
          >
            <Trash2 className={iconCls} strokeWidth={1.75} />
            <span>{t('doc.deleteDoc')}</span>
          </button>
        </div>,
        document.body,
      )}
    </>
  )
}
