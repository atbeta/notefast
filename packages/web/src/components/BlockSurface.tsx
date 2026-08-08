/**
 * 阅读态块级菜单（⋮ handle）
 *
 * 每个块左侧 gutter 浮出 handle（桌面 hover 显现 / 触屏常显淡化），菜单三项：
 * 复制块链接 / 复制块内容（含子块）/ 问 AI 关于这一段（打开聊天面板并预填草稿，
 * 不自动发送——写之前用户可审阅编辑引用范围）。
 *
 * 阅读态 v1 刻意不做：inline 结果卡、块类型特化、定位到大纲、编辑器集成。
 * （选区气泡在编辑器侧单独实现，见 components/editor/SelectionBubble.tsx）
 * 手机（<sm）不出 handle：16px 内容边距放不下 gutter，且 iOS 长按/选区/键盘
 * 冲突是另一个量级的坑，留待重构期统一解。
 *
 * 注意：wrapper 只加 relative，不加任何 margin/padding——块间距依赖
 * `.reading-prose > * + *` 与子块外边距折叠，wrapper 有 padding 会破坏折叠。
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Copy, Link2, MoreVertical, Sparkles } from 'lucide-react'
import { blocksToMarkdown, type Block } from '@notefast/core'
import { dispatchAskAi } from '../lib/askAi'
import { useToast } from './ui'

/** 预填引用的长度上限，避免整篇长文塞进输入框 */
const QUOTE_MAX = 600

const iconCls = 'w-3.5 h-3.5 shrink-0'

interface BlockHandleProps {
  block: Block
  /** handle 定位类（gutter 偏移 + 垂直对齐）；列表项缩进更深，需另传 */
  className: string
}

export function BlockHandle({ block, className }: BlockHandleProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; openUp: boolean } | null>(null)

  const close = useCallback(() => setOpen(false), [])

  // 定位逻辑与 DocActionsMenu 一致：右对齐 trigger，近底向上翻
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
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return
      close()
    }
    const onScroll = () => close()
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, close])

  const copyText = async (text: string, doneTitle: string) => {
    close()
    try {
      await navigator.clipboard.writeText(text)
      toast.success({ title: doneTitle })
    } catch {
      toast.error({ title: t('block.copyFailed') })
    }
  }

  // 与 AIChatPanel citation 跳转一致的 `#block-<id>` 形式（doc 页 hash 滚动两种都认）
  const handleCopyLink = () =>
    void copyText(
      `${window.location.origin}${window.location.pathname}#block-${block.id}`,
      t('block.linkCopied'),
    )

  const handleCopyContent = () =>
    void copyText(blocksToMarkdown([block]), t('block.contentCopied'))

  const handleAskAi = () => {
    close()
    const quote = blocksToMarkdown([block]).trim()
    if (!quote) return
    dispatchAskAi({ quote: quote.length > QUOTE_MAX ? `${quote.slice(0, QUOTE_MAX)}…` : quote })
  }

  const items = [
    {
      id: 'copy-link',
      label: t('block.copyLink'),
      icon: <Link2 className={iconCls} strokeWidth={1.75} />,
      onSelect: handleCopyLink,
    },
    {
      id: 'copy-content',
      label: t('block.copyContent'),
      icon: <Copy className={iconCls} strokeWidth={1.75} />,
      onSelect: handleCopyContent,
    },
    {
      id: 'ask-ai',
      label: t('block.askAi'),
      icon: <Sparkles className={iconCls} strokeWidth={1.75} />,
      onSelect: handleAskAi,
    },
  ]

  // 打开后常显（避免移入菜单时消失）。
  // 注意不能给隐藏态加 pointer-events-none：handle 位于块盒之外的 gutter，
  // pointer-events-none 时它永远不会成为 hit 目标，鼠标从正文移入 gutter 的瞬间
  // group-hover 就断开（鸡生蛋死锁，handle 永远点不到）。隐藏仅靠 opacity——
  // handle 始终位于 gutter（嵌套列表项不渲染 handle），不会压正文。
  const visibility = open
    ? 'opacity-100'
    : 'opacity-0 group-hover/bs:opacity-100 group-focus-within/bs:opacity-100 sm:[@media(hover:none)]:opacity-40'

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t('block.menuLabel')}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className={`absolute z-10 hidden sm:inline-flex w-6 h-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-all ${visibility} ${className}`}
      >
        <MoreVertical className="w-4 h-4" strokeWidth={1.75} />
      </button>

      {open && pos && createPortal(
        <div
          ref={panelRef}
          id={menuId}
          role="menu"
          aria-label={t('block.menuLabel')}
          className="fixed z-[80] min-w-[180px] max-w-[240px] py-1 rounded-lg border border-border bg-popover text-popover-foreground shadow-[var(--shadow-floating)] animate-fade-in"
          style={{
            top: pos.openUp ? undefined : pos.top,
            bottom: pos.openUp ? window.innerHeight - pos.top : undefined,
            left: pos.left,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => item.onSelect()}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[13px] text-left text-foreground hover:bg-accent transition-colors"
            >
              <span className="text-muted-foreground">{item.icon}</span>
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}

/** 块包装器：hover 分组 + handle 锚点，不改变块布局。
 *  顶层挂 data-block-id：DocContextMenu 通过该 attr 反查 Block（避免与
 *  heading 等原生 id 碰撞；同时不必信赖 DOM id 是否一定来自 BlockRenderer）。 */
export default function BlockSurface({ block, children }: { block: Block; children: ReactNode }) {
  return (
    <div className="group/bs relative" data-block-id={block.id}>
      {/* -left-6 + w-6：按钮右缘与块边缘贴合（-24..0），正文 → handle 无 hover 死区，
          否则鼠标一过界就吃 pointer-events-none 永远点不到（列表项靠 li 的 before 桥解同一问题） */}
      <BlockHandle block={block} className="-left-6 top-1" />
      {children}
    </div>
  )
}
