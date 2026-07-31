/**
 * 文档行溢出菜单（⋯）
 *
 * 主列表 / 侧栏最近 / 收集箱 / 归档共用；导出等后续能力挂同一菜单。
 * 触发：桌面 hover / 触控常显；打开后保持可见，避免移入菜单时消失。
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
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
import { api, fetchWithAuth } from '../hooks/useAPI'
import { parseContentDispositionFilename, triggerBlobDownload } from '../lib/download'
import ConfirmDialog from './ConfirmDialog'
import ShareDialog from './ShareDialog'
import { useToast } from './ui'

export type DocActionsSurface = 'list' | 'sidebar' | 'inbox' | 'archived'

export interface DocActionsMenuProps {
  doc: DocSummary
  /** 控制菜单项显隐与文案；默认 list */
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
  const toast = useToast()
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

  const status = doc.status === 'inbox' || doc.status === 'archived' ? doc.status : 'note'
  const aiExclude = doc.ai_exclude === true
  const title = doc.title || '未命名文档'

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

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return
      close()
    }
    const onScroll = () => close()
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', close)
    // 捕获滚动：列表/侧栏滚动时收起，避免错位
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, close])

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
      toast.error({ title: '重命名失败' })
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
        title: next === 'archived' ? '已归档' : status === 'inbox' ? '已加入笔记' : '已恢复为笔记',
        durationMs: 6000,
        action: {
          label: '撤销',
          onClick: () => {
            void (async () => {
              try {
                await api.patch(`/docs/${doc.id}/status`, { status })
                afterMutation()
              } catch {
                toast.error({ title: '撤销失败' })
              }
            })()
          },
        },
      })
    } catch {
      toast.error({ title: '操作失败' })
    } finally {
      setBusy(false)
    }
  }

  const toggleAiExclude = async () => {
    setBusy(true)
    close()
    try {
      await api.patch(`/docs/${doc.id}/ai-exclude`, { ai_exclude: !aiExclude })
      afterMutation()
      toast.success({ title: aiExclude ? '已恢复对 AI 可见' : '已对 AI 隐藏' })
    } catch {
      toast.error({ title: '操作失败' })
    } finally {
      setBusy(false)
    }
  }

  const handleExport = async () => {
    setBusy(true)
    close()
    try {
      const res = await fetchWithAuth(`/docs/${doc.id}/export/file`)
      if (!res.ok) {
        toast.error({ title: '导出失败' })
        return
      }
      const blob = await res.blob()
      const filename =
        parseContentDispositionFilename(res.headers.get('Content-Disposition'))
        || (blob.type.includes('zip') ? `${title}.zip` : `${title}.md`)
      triggerBlobDownload(blob, filename)
      toast.success({
        title: filename.endsWith('.zip') ? '已导出（含图片）' : '已导出 Markdown',
      })
    } catch {
      toast.error({ title: '导出失败' })
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    setBusy(true)
    try {
      await api.del(`/docs/${doc.id}`)
      setShowDelete(false)
      afterMutation()
      // 软删除 + restore 端点：Undo toast 是 Web 上唯一的恢复入口
      toast.success({
        title: surface === 'inbox' ? '已丢弃' : '已删除',
        durationMs: 6000,
        action: {
          label: '撤销',
          onClick: () => {
            void (async () => {
              try {
                await api.post(`/blocks/${doc.id}/restore`, {})
                afterMutation()
                toast.success({ title: '已恢复' })
              } catch {
                toast.error({ title: '撤销失败' })
              }
            })()
          },
        },
      })
    } catch {
      toast.error({ title: '删除失败' })
      setBusy(false)
      setShowDelete(false)
    }
  }

  const items: MenuItem[] = []

  items.push({
    id: 'open-tab',
    label: '在新标签打开',
    icon: <ExternalLink className={iconCls} strokeWidth={iconStroke} />,
    onSelect: () => {
      close()
      window.open(`/doc/${doc.id}`, '_blank', 'noopener,noreferrer')
    },
  })

  items.push({
    id: 'rename',
    label: '重命名',
    icon: <Pencil className={iconCls} strokeWidth={iconStroke} />,
    onSelect: () => {
      close()
      if (onRename) onRename()
      else setShowRename(true)
    },
  })

  if (surface === 'inbox') {
    items.push({
      id: 'promote',
      label: '加入笔记',
      icon: <ArrowUpRight className={iconCls} strokeWidth={iconStroke} />,
      onSelect: () => { void patchStatus('note') },
      disabled: busy,
    })
  } else if (surface === 'archived' || status === 'archived') {
    items.push({
      id: 'restore',
      label: '恢复为笔记',
      icon: <ArchiveRestore className={iconCls} strokeWidth={iconStroke} />,
      onSelect: () => { void patchStatus('note') },
      disabled: busy,
    })
  } else if (status !== 'inbox') {
    items.push({
      id: 'archive',
      label: '归档',
      icon: <Archive className={iconCls} strokeWidth={iconStroke} />,
      onSelect: () => { void patchStatus('archived') },
      disabled: busy,
    })
  }

  items.push({
    id: 'share',
    label: '分享…',
    icon: <Share2 className={iconCls} strokeWidth={iconStroke} />,
    onSelect: () => {
      close()
      setShowShare(true)
    },
  })

  items.push({
    id: 'export',
    label: '导出',
    icon: <Download className={iconCls} strokeWidth={iconStroke} />,
    onSelect: () => { void handleExport() },
    disabled: busy,
  })

  items.push({
    id: 'ai-exclude',
    label: aiExclude ? '恢复对 AI 可见' : '对 AI 隐藏',
    icon: aiExclude
      ? <Eye className={iconCls} strokeWidth={iconStroke} />
      : <EyeOff className={iconCls} strokeWidth={iconStroke} />,
    onSelect: () => { void toggleAiExclude() },
    disabled: busy,
  })

  items.push({
    id: 'delete',
    label: surface === 'inbox' ? '丢弃' : '删除',
    icon: <Trash2 className={iconCls} strokeWidth={iconStroke} />,
    onSelect: () => {
      close()
      setShowDelete(true)
    },
    danger: true,
  })

  // 危险项前加分隔：用 index 找 delete
  const deleteIdx = items.findIndex((i) => i.id === 'delete')

  const triggerSize = compact ? 'w-6 h-6' : 'w-7 h-7'
  const triggerVisible = open
    ? 'opacity-100'
    : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'

  return (
    <>
      <div className={`relative shrink-0 ${className}`}>
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label={`「${title}」的更多操作`}
          disabled={busy}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setOpen((v) => !v)
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className={`${triggerSize} inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-all ${triggerVisible}`}
        >
          <MoreHorizontal className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} strokeWidth={1.75} />
        </button>
      </div>

      {open && pos && createPortal(
        <div
          ref={panelRef}
          id={menuId}
          role="menu"
          aria-label="文档操作"
          className="fixed z-[80] min-w-[180px] max-w-[240px] py-1 rounded-lg border border-border bg-popover text-popover-foreground shadow-[var(--shadow-floating)] animate-fade-in "
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
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-[13px] text-left transition-colors disabled:opacity-40 ${
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
        title={surface === 'inbox' ? '丢弃收集项' : '删除文档'}
        message={
          surface === 'inbox'
            ? `确定丢弃「${title}」吗？丢弃后可在右下角提示中撤销。`
            : `确定要删除「${title}」吗？删除后可在右下角提示中撤销。`
        }
        confirmLabel={busy ? (surface === 'inbox' ? '丢弃中…' : '删除中…') : (surface === 'inbox' ? '丢弃' : '删除')}
        destructive
        onConfirm={() => { void handleDelete() }}
        onCancel={() => setShowDelete(false)}
      />

      {showShare && (
        <ShareDialog docId={doc.id} onClose={() => setShowShare(false)} />
      )}

      {showRename && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center">
          <div className="fixed inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => setShowRename(false)} />
          <div className="relative bg-card rounded-lg shadow-2xl shadow-black/40 max-w-sm w-full mx-4 p-6 animate-fade-in">
            <h3 className="text-[15px] font-medium text-foreground tracking-tight mb-3">重命名</h3>
            <input
              ref={renameInputRef}
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void handleRenameSubmit() }
                if (e.key === 'Escape') setShowRename(false)
              }}
              className="w-full px-3 py-2 text-[14px] rounded-md border border-border bg-background text-foreground outline-none focus:border-foreground/30"
              placeholder="文档标题"
              disabled={busy}
            />
            <div className="flex justify-end gap-2.5 mt-5">
              <button
                type="button"
                onClick={() => setShowRename(false)}
                className="px-3.5 py-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 rounded-md transition-colors"
              >
                取消
              </button>
              <button
                type="button"
                disabled={busy || !renameDraft.trim()}
                onClick={() => { void handleRenameSubmit() }}
                className="px-3.5 py-1.5 text-[13px] font-medium rounded-md bg-foreground text-background shadow-sm hover:bg-foreground/90 disabled:opacity-40 transition-all"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
