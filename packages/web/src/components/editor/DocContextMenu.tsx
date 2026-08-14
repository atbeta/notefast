/**
 * 阅读 / 预览态文档区自定义右键菜单
 *
 * 背景：nativeShell 在壳层（WebView2 / WKWebView）屏蔽浏览器默认右键菜单
 * （保留 input/textarea/select/contenteditable），原意是杜绝"查看源代码 /
 * 打印 / 检查元素"等违和项。BlockRenderer 输出的块在阅读态是非 editable
 * HTML，一刀切后用户无法用右键复制，体验缺失。本组件接管文档区的
 * `contextmenu`，出一个与 BlockHandle / DocActionsMenu 视觉一致的自定义菜单。
 *
 * 用法（hook 返回 onContextMenu/onKeyDown + menu JSX，避免包装式 div）：
 *   const ctx = useDocContextMenu({ rootBlock: doc, disabled: isEmpty })
 *   return (<>
 *     <article
 *       onContextMenu={ctx.onContextMenu}
 *       onKeyDown={ctx.onKeyDown}>
 *       <BlockRenderer block={doc} />
 *     </article>
 *     {ctx.menu}
 *   </>)
 *
 * 菜单项（动态拼装）：
 *  - 有选区（window.getSelection 非空）：复制选区
 *  - 命中块（closest('[data-block-id]') 非空）：复制块链接 / 复制块内容
 *  - 选区或块任一非空：问 AI
 *  - 都没有则不显示。
 *
 * 关键交互：
 *  - `e.preventDefault()` 阻浏览器原生菜单；`e.stopPropagation()` 阻
 *    nativeShell.ts 的全局 listener 兜底拦截。
 *  - 菜单定位：右贴光标 → 溢出则向上翻 → 左/底 clamp 到 PAD。
 *  - Esc / 外部 mousedown / window scroll+resize 关闭（菜单自身右键不关闭）。
 *  - 键盘可访问性：Shift+F10 在焦点宿主上任意位置打开菜单（按选区或宿主中心）。
 */

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Copy, Link2, Sparkles } from 'lucide-react'
import { blocksToMarkdown, type Block } from '@notefast/core'
import { dispatchAskAi } from '../../lib/askAi'
import { useToast } from '../ui'
import { useAiCapabilities } from '../../hooks/useAiCapabilities'
import { usePopoverDismiss } from '../../hooks/usePopoverDismiss'

/** 与 BlockSurface.QUOTE_MAX 对齐，避免长选区塞爆聊天草稿 */
const QUOTE_MAX = 600
const PANEL_W = 200
const APPROX_H = 168
const PAD = 8
const ICON_CLS = 'w-3.5 h-3.5 shrink-0'

export interface MenuItem {
  id: string
  label: string
  icon: ReactNode
  onSelect: () => void
}

export interface MenuPos {
  top: number
  left: number
  openUp: boolean
}

interface UseDocContextMenuOptions {
  /** 文档根块；用于 right-click 时按 id 查回 Block 节点做 md 序列化 */
  rootBlock: Block | null
  /** 树为空或不需要菜单时关闭监听 */
  disabled?: boolean
}

interface UseDocContextMenuResult {
  /** 挂在文档容器元素上的 contextmenu 监听器 */
  onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void
  /** Shift+F10 键盘可访问性 */
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void
  /** 当前菜单 JSX（关闭态为 null），caller 直接 `{ctx.menu}` 渲染 */
  menu: ReactNode
  /** 外部强制关闭 */
  close: () => void
}

/** 递归遍历整棵树构建 id -> Block 索引，O(N) 一次，right-click 时 O(1) 查 */
function buildBlockIndex(root: Block | null): Map<string, Block> {
  const m = new Map<string, Block>()
  if (!root) return m
  const visit = (b: Block) => {
    m.set(b.id, b)
    for (const c of b.children) visit(c)
  }
  visit(root)
  return m
}

export function useDocContextMenu({
  rootBlock,
  disabled,
}: UseDocContextMenuOptions): UseDocContextMenuResult {
  const { t } = useTranslation()
  const toast = useToast()
  const ai = useAiCapabilities()
  const triggerRef = useRef<HTMLElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [snap, setSnap] = useState<{
    pos: MenuPos | null
    items: MenuItem[]
  }>({ pos: null, items: [] })

  const open = snap.pos !== null
  const close = useCallback(
    () => setSnap((s) => (s.pos ? { pos: null, items: [] } : s)),
    [],
  )

  const blockIndex = useMemo(() => buildBlockIndex(rootBlock), [rootBlock])

  const copyText = useCallback(
    async (text: string, doneTitle: string) => {
      close()
      try {
        await navigator.clipboard.writeText(text)
        toast.success({ title: doneTitle })
      } catch {
        toast.error({ title: t('block.copyFailed') })
      }
    },
    [close, toast, t],
  )

  const dispatchAskAiWithQuote = useCallback(
    (quote: string) => {
      close()
      if (!quote) return
      dispatchAskAi({
        quote: quote.length > QUOTE_MAX ? `${quote.slice(0, QUOTE_MAX)}…` : quote,
      })
    },
    [close],
  )

  const buildItems = useCallback(
    (targetEl: HTMLElement): MenuItem[] => {
      const blockEl = targetEl.closest<HTMLElement>('[data-block-id]')
      const blockId = blockEl?.getAttribute('data-block-id') ?? null
      const block = blockId ? blockIndex.get(blockId) ?? null : null
      const selection = window.getSelection()?.toString().trim() ?? ''
      const blockMd = block ? blocksToMarkdown([block]).trim() : ''
      const askQuote = selection || blockMd

      const out: MenuItem[] = []

      if (selection) {
        out.push({
          id: 'copy-selection',
          label: t('contextMenu.copySelection'),
          icon: <Copy className={ICON_CLS} strokeWidth={1.75} />,
          onSelect: () => void copyText(selection, t('contextMenu.selectionCopied')),
        })
      }

      if (block) {
        out.push({
          id: 'copy-block-link',
          label: t('block.copyLink'),
          icon: <Link2 className={ICON_CLS} strokeWidth={1.75} />,
          onSelect: () =>
            void copyText(
              `${window.location.origin}${window.location.pathname}#block-${block.id}`,
              t('block.linkCopied'),
            ),
        })
        out.push({
          id: 'copy-block-content',
          label: t('block.copyContent'),
          icon: <Copy className={ICON_CLS} strokeWidth={1.75} />,
          onSelect: () => void copyText(blocksToMarkdown([block]), t('block.contentCopied')),
        })
      }

      // 未配置 Chat 时不展示：打开面板只会看到空态
      if (askQuote && ai.chat) {
        out.push({
          id: 'ask-ai',
          label: selection
            ? t('contextMenu.askAiAboutSelection')
            : t('block.askAi'),
          icon: <Sparkles className={ICON_CLS} strokeWidth={1.75} />,
          onSelect: () => dispatchAskAiWithQuote(askQuote),
        })
      }

      return out
    },
    [ai.chat, blockIndex, copyText, dispatchAskAiWithQuote, t],
  )

  const computePos = useCallback((clientX: number, clientY: number, host: HTMLElement): MenuPos => {
    const r = host.getBoundingClientRect()
    const openUp = clientY + APPROX_H > window.innerHeight - PAD && r.top > APPROX_H
    let left = clientX
    left = Math.max(PAD, Math.min(left, window.innerWidth - PANEL_W - PAD))
    let top = clientY
    if (openUp) {
      top = Math.max(PAD, r.bottom - APPROX_H)
    } else {
      top = Math.min(window.innerHeight - APPROX_H - PAD, top)
    }
    return { top, left, openUp }
  }, [])

  const handleContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      if (disabled) return
      // 自有菜单 + 阻止原生菜单 + 阻止 nativeShell.ts 兜底
      e.preventDefault()
      e.stopPropagation()
      triggerRef.current = e.currentTarget

      const items = buildItems(e.target as HTMLElement)
      if (items.length === 0) return
      setSnap({ pos: computePos(e.clientX, e.clientY, e.currentTarget), items })
    },
    [buildItems, computePos, disabled],
  )

  // Shift+F10 打开（键盘可访问性）。位置取选区中心或宿主中心。
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      if (disabled) return
      if (e.key !== 'F10' || !e.shiftKey) return
      e.preventDefault()
      const host = e.currentTarget
      triggerRef.current = host
      const items = buildItems(host)
      if (items.length === 0) return
      const r = host.getBoundingClientRect()
      let cx = r.left + r.width / 2
      let cy = r.top + r.height / 2
      const sel = window.getSelection()
      if (sel && sel.rangeCount > 0) {
        const rr = sel.getRangeAt(0).getBoundingClientRect()
        if (rr.width > 0 || rr.height > 0) {
          cx = rr.left + rr.width / 2
          cy = rr.top + rr.height / 2
        }
      }
      setSnap({ pos: computePos(cx, cy, host), items })
    },
    [buildItems, computePos, disabled],
  )

  // Esc / 外部 mousedown / window scroll+resize 关闭
  usePopoverDismiss(open, { onClose: close, closeOnScroll: true, closeOnResize: true }, triggerRef, panelRef)

  // 面板 JSX —— hook 内部统一 manage panelRef，避免 caller 还要 wire ref
  const menu: ReactNode = open && snap.pos
    ? createPortal(
        <div
          ref={panelRef}
          role="menu"
          aria-label={t('contextMenu.menuLabel')}
          className="fixed z-[80] min-w-[180px] max-w-[240px] py-1 rounded-lg border border-border bg-popover text-popover-foreground shadow-[var(--shadow-floating)] animate-fade-in"
          style={{
            top: snap.pos.openUp ? undefined : snap.pos.top,
            bottom: snap.pos.openUp ? window.innerHeight - snap.pos.top : undefined,
            left: snap.pos.left,
          }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            // 菜单自身的右键吃掉（不冒泡到 document；不关闭）
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          {snap.items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => {
                item.onSelect()
                close()
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-foreground hover:bg-accent focus:bg-accent focus:outline-none transition-colors"
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )
    : null

  return { onContextMenu: handleContextMenu, onKeyDown: handleKeyDown, menu, close }
}
