/**
 * 文档行溢出菜单（⋯）
 *
 * 主列表 / 侧栏最近 / 收集箱 / 归档共用。菜单项按文档生命周期拼装，
 * 不因所在页面而混用（侧栏里的收集箱项也是「加入笔记」，不是「归档」）。
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  MoreHorizontal,
  Pencil,
  Share2,
  Trash2,
} from 'lucide-react'
import type { DocSummary } from '@notefast/core'
import { api } from '../hooks/useAPI'
import { useApiMutation } from '../hooks/useApiMutation'
import { usePopoverDismiss } from '../hooks/usePopoverDismiss'
import { deliverExport, fetchDocExportFile } from '../lib/download'
import { Input } from './ui'
import ConfirmDialog from './ConfirmDialog'
import ShareDialog from './ShareDialog'
import { Tooltip, useToast } from './ui'
import { docActionIdsFor, isReadingDoc, resolveDocLifecycle, type DocActionId } from '../lib/docActions'
import { removeVisit } from '../lib/recentVisits'

export type DocActionsSurface = 'list' | 'sidebar' | 'inbox' | 'archived'

export interface DocActionsMenuProps {
  doc: DocSummary
  /** 页面入口兜底；菜单项优先按 doc.status 拼装 */
  surface?: DocActionsSurface
  /** 变更后刷新列表 */
  onDone?: () => void
  /**
   * 若提供：重命名交给父级（如 DocList 行内编辑）；
   * 否则菜单内弹简易重命名框。
   */
  onRename?: () => void
  className?: string
  /** 侧栏窄行用更小触发钮 */
  compact?: boolean
}

type MenuItem = {
  id: string
  label: string
  icon: ReactNode
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
}

const iconCls = 'w-3.5 h-3.5 shrink-0'
const iconStroke = 1.75

export default function DocActionsMenu({
  doc,
  surface = 'list',
  onDone,
  onRename,
  className = '',
  compact = false,
}: DocActionsMenuProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; openUp: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const [showRename, setShowRename] = useState(false)
  const [renameDraft, setRenameDraft] = useState(doc.title)

  const status = resolveDocLifecycle(doc.status, surface)
  const isInbox = status === 'inbox'
  const aiExclude = doc.ai_exclude === true
  const title = doc.title || t('docActions.untitled')

  const close = useCallback(() => setOpen(false), [])

  const placeMenu = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const panelW = 200
    const approxH = 280
    const pad = 8
    const openUp = r.bottom + approxH > window.innerHeight - pad && r.top > approxH
    let left = r.right - panelW
    left = Math.max(pad, Math.min(left, window.innerWidth - panelW - pad))
    const top = openUp ? r.top - pad : r.bottom + 4
    setPos({ top, left, openUp })
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
    { onClose: close, closeOnScroll: true, closeOnResize: true },
    triggerRef,
    panelRef,
  )

  useEffect(() => {
    if (showRename) {
      setRenameDraft(doc.title)
      const t = setTimeout(() => {
        renameInputRef.current?.focus()
        renameInputRef.current?.select()
      }, 30)
      return () => clearTimeout(t)
    }
  }, [showRename, doc.title])

  const afterMutation = useCallback(() => {
    onDone?.()
  }, [onDone])

  // PATCH 是幂等可重试的；useApiMutation 默认 3 次指数退避，仅 network error 重试
  const toggleAiExcludeMut = useApiMutation<
    { docId: string; ai_exclude: boolean },
    { ok: boolean }
  >({
    method: 'patch',
    path: '/docs/:docId/ai-exclude',
    onSuccess: () => {
      afterMutation()
      toast.success({ title: aiExclude ? t('docActions.aiRestore') : t('docActions.aiHide') })
    },
    onError: () => toast.error({ title: t('docActions.operationFailed') }),
  })

  const handleRenameSubmit = async () => {
    const next = renameDraft.trim()
    if (!next || next === doc.title) {
      setShowRename(false)
      return
    }
    setBusy(true)
    try {
      await api.patch(`/blocks/${doc.id}`, { content: next })
      setShowRename(false)
      afterMutation()
    } catch {
      toast.error({ title: t('docActions.renameFailed') })
    } finally {
      setBusy(false)
    }
  }

  const patchStatus = async (next: 'note' | 'archived') => {
    setBusy(true)
    close()
    try {
      await api.patch(`/docs/${doc.id}/status`, { status: next })
      afterMutation()
      toast.success({
        title: next === 'archived'
          ? t('docActions.archived')
          : isInbox
            ? t('docActions.addedToNotes')
            : t('docActions.restoredToNotes'),
        durationMs: 6000,
        action: {
          label: t('docActions.undo'),
          onClick: () => {
            void (async () => {
              try {
                await api.patch(`/docs/${doc.id}/status`, { status })
                afterMutation()
              } catch {
                toast.error({ title: t('docActions.undoFailed') })
              }
            })()
          },
        },
      })
    } catch {
      toast.error({ title: t('docActions.operationFailed') })
    } finally {
      setBusy(false)
    }
  }

  const toggleAiExclude = async () => {
    setBusy(true)
    close()
    try {
      await toggleAiExcludeMut.mutate({ docId: doc.id, ai_exclude: !aiExclude })
    } finally {
      setBusy(false)
    }
  }

  const handleExport = async () => {
    setBusy(true)
    close()
    try {
      const { blob, filename } = await fetchDocExportFile(doc.id, title)
      const delivery = await deliverExport(blob, filename)
      if (delivery.mode === 'saved') {
        toast.success({ title: t('docActions.exportedTo', { path: delivery.savedPath }) })
      } else if (delivery.mode === 'downloaded') {
        toast.success({
          title: filename.endsWith('.zip') ? t('docActions.exportedWithImages') : t('docActions.exportedMarkdown'),
        })
      }
    } catch (err) {
      toast.error({
        title: t('docActions.exportFailed'),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    setBusy(true)
    try {
      await api.del(`/docs/${doc.id}`)
      setShowDelete(false)
      removeVisit(doc.id)
      if (isReadingDoc(pathname, doc.id)) navigate('/')
      afterMutation()
      // 软删除 + restore 端点：Undo toast 是 Web 上唯一的恢复入口
      toast.success({
        title: isInbox ? t('docActions.discarded') : t('docActions.deleted'),
        durationMs: 6000,
        action: {
          label: t('docActions.undo'),
          onClick: () => {
            void (async () => {
              try {
                await api.post(`/blocks/${doc.id}/restore`, {})
                afterMutation()
                toast.success({ title: t('docActions.restored') })
              } catch {
                toast.error({ title: t('docActions.undoFailed') })
              }
            })()
          },
        },
      })
    } catch {
      toast.error({ title: t('docActions.deleteFailed') })
      setBusy(false)
      setShowDelete(false)
    }
  }

  const byId: Record<DocActionId, MenuItem> = {
    'open-tab': {
      id: 'open-tab',
      label: t('docActions.openInNewTab'),
      icon: <ExternalLink className={iconCls} strokeWidth={iconStroke} />,
      onSelect: () => {
        close()
        window.open(`/doc/${doc.id}`, '_blank', 'noopener,noreferrer')
      },
    },
    rename: {
      id: 'rename',
      label: t('docActions.rename'),
      icon: <Pencil className={iconCls} strokeWidth={iconStroke} />,
      onSelect: () => {
        close()
        if (onRename) onRename()
        else setShowRename(true)
      },
    },
    promote: {
      id: 'promote',
      label: t('docActions.addToNotes'),
      icon: <ArrowUpRight className={iconCls} strokeWidth={iconStroke} />,
      onSelect: () => { void patchStatus('note') },
      disabled: busy,
    },
    restore: {
      id: 'restore',
      label: t('docActions.restoreToNotes'),
      icon: <ArchiveRestore className={iconCls} strokeWidth={iconStroke} />,
      onSelect: () => { void patchStatus('note') },
      disabled: busy,
    },
    archive: {
      id: 'archive',
      label: t('docActions.archive'),
      icon: <Archive className={iconCls} strokeWidth={iconStroke} />,
      onSelect: () => { void patchStatus('archived') },
      disabled: busy,
    },
    share: {
      id: 'share',
      label: t('docActions.share'),
      icon: <Share2 className={iconCls} strokeWidth={iconStroke} />,
      onSelect: () => {
        close()
        setShowShare(true)
      },
    },
    export: {
      id: 'export',
      label: t('docActions.export'),
      icon: <Download className={iconCls} strokeWidth={iconStroke} />,
      onSelect: () => { void handleExport() },
      disabled: busy,
    },
    'ai-exclude': {
      id: 'ai-exclude',
      label: aiExclude ? t('docActions.restoreAiVisibility') : t('docActions.hideFromAi'),
      icon: aiExclude
        ? <Eye className={iconCls} strokeWidth={iconStroke} />
        : <EyeOff className={iconCls} strokeWidth={iconStroke} />,
      onSelect: () => { void toggleAiExclude() },
      disabled: busy,
    },
    delete: {
      id: 'delete',
      label: isInbox ? t('docActions.discard') : t('docActions.delete'),
      icon: <Trash2 className={iconCls} strokeWidth={iconStroke} />,
      onSelect: () => {
        close()
        setShowDelete(true)
      },
      danger: true,
    },
  }

  const items: MenuItem[] = docActionIdsFor(status).map((id) => byId[id])

  // 危险项前加分隔：用 index 找 delete
  const deleteIdx = items.findIndex((i) => i.id === 'delete')

  const triggerSize = compact ? 'w-6 h-6' : 'w-7 h-7'
  const triggerVisible = open
    ? 'opacity-100'
    : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'

  return (
    <>
      <div className={`relative shrink-0 ${className}`}>
        <Tooltip label={t('docActions.moreActionsTooltip')}>
          <button
            ref={triggerRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            aria-label={t('docActions.moreActionsFor', { title })}
            disabled={busy}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setOpen((v) => !v)
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className={`${triggerSize} inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${triggerVisible}`}
          >
            <MoreHorizontal className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>

      {open && pos && createPortal(
        <div
          ref={panelRef}
          id={menuId}
          role="menu"
          aria-label={t('docActions.menuLabel')}
          className="fixed z-popover min-w-[180px] max-w-[240px] py-1 rounded-lg border border-border bg-popover text-popover-foreground shadow-floating animate-fade-in "
          style={{
            top: pos.openUp ? undefined : pos.top,
            bottom: pos.openUp ? window.innerHeight - pos.top : undefined,
            left: pos.left,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {items.map((item, idx) => (
            <div key={item.id}>
              {idx === deleteIdx && deleteIdx > 0 && (
                <div className="my-1 mx-2 h-px bg-border/80" role="separator" />
              )}
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => item.onSelect()}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-base text-left transition-colors disabled:opacity-40 ${
                  item.danger
                    ? 'text-destructive hover:bg-destructive/10'
                    : 'text-foreground hover:bg-accent'
                }`}
              >
                <span className={item.danger ? 'text-destructive' : 'text-muted-foreground'}>
                  {item.icon}
                </span>
                <span className="truncate">{item.label}</span>
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}

      <ConfirmDialog
        open={showDelete}
        title={isInbox ? t('docActions.confirmDiscardTitle') : t('docActions.confirmDeleteTitle')}
        message={
          isInbox
            ? t('docActions.confirmDiscardMsg', { title })
            : t('docActions.confirmDeleteMsg', { title })
        }
        confirmLabel={isInbox ? t('docActions.discard') : t('docActions.delete')}
        busy={busy}
        busyLabel={isInbox ? t('docActions.discarding') : t('docActions.deleting')}
        tone="destructive"
        onConfirm={() => { void handleDelete() }}
        onCancel={() => setShowDelete(false)}
      />

      {showShare && (
        <ShareDialog docId={doc.id} onClose={() => setShowShare(false)} />
      )}

      {showRename && createPortal(
        <div className="fixed inset-0 z-dialog flex items-center justify-center">
          <div className="fixed inset-0 dialog-overlay" onClick={() => setShowRename(false)} />
          <div className="relative bg-card dialog-card max-w-sm w-full mx-4 p-6 animate-fade-in">
            <h3 className="text-md font-medium text-foreground tracking-tight mb-3">{t('docActions.renameTitle')}</h3>
            <Input
              ref={renameInputRef}
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void handleRenameSubmit() }
                if (e.key === 'Escape') setShowRename(false)
              }}
              className="py-2"
              placeholder={t('docActions.titlePlaceholder')}
              disabled={busy}
            />
            <div className="flex justify-end gap-2.5 mt-5">
              <button
                type="button"
                onClick={() => setShowRename(false)}
                className="px-3.5 py-1.5 text-base font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 rounded-md transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                disabled={busy || !renameDraft.trim()}
                onClick={() => { void handleRenameSubmit() }}
                className="px-3.5 py-1.5 text-base font-medium rounded-md bg-foreground text-background shadow-btn hover:bg-foreground/90 disabled:opacity-40 transition-colors"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
