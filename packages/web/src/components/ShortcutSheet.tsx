import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Keyboard } from 'lucide-react'
import { usePopoverDismiss } from '../hooks/usePopoverDismiss'
import { useShortcutScope } from '../hooks/useShortcutScope'
import { useDemoMode } from '../hooks/useDemoMode'
import { useAiCapabilities } from '../hooks/useAiCapabilities'
import { shortcutGroups, type ShortcutItem } from '../lib/shortcutCatalog'
import { ShortcutKeys } from './ui'

/**
 * 内容顶栏键盘图标：悬停列出当前界面可用快捷键。
 * 点一下钉住；Esc / 点外部关闭。触控顶栏另有入口，此处仅 md+。
 */
export default function ShortcutSheet() {
  const { t } = useTranslation()
  const { page } = useShortcutScope()
  const demo = useDemoMode()
  const ai = useAiCapabilities()
  const groups = shortcutGroups({
    page,
    aiContinue: page === 'doc-editing' && ai.chat,
    demoActive: demo.active,
  })

  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }

  const place = () => {
    const el = btnRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ top: r.bottom + 6, right: window.innerWidth - r.right })
  }

  const show = () => {
    cancelClose()
    place()
    setOpen(true)
  }

  const hide = useCallback(() => {
    cancelClose()
    setOpen(false)
    setPinned(false)
    setPos(null)
  }, [])

  const scheduleHide = () => {
    if (pinned) return
    cancelClose()
    closeTimer.current = setTimeout(() => {
      setOpen(false)
      setPos(null)
    }, 180)
  }

  usePopoverDismiss(open, {
    onClose: hide,
    onEscape: (e) => {
      e.preventDefault()
      e.stopPropagation()
      hide()
    },
  }, panelRef, btnRef)

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="hidden md:inline-flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors print:hidden"
        aria-label={t('shortcuts.sheetLabel')}
        aria-expanded={open}
        aria-haspopup="dialog"
        onMouseEnter={show}
        onMouseLeave={scheduleHide}
        onClick={() => {
          if (open && pinned) hide()
          else {
            show()
            setPinned(true)
          }
        }}
      >
        <Keyboard className="w-3.5 h-3.5" strokeWidth={1.75} />
      </button>
      {open && pos && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label={t('shortcuts.sheetLabel')}
          className="fixed z-popover w-[260px] py-2 rounded-lg border border-border bg-popover text-popover-foreground shadow-floating animate-fade-in"
          style={{ top: pos.top, right: pos.right }}
          onMouseEnter={() => { cancelClose(); setOpen(true) }}
          onMouseLeave={scheduleHide}
        >
          {groups.local.length > 0 && (
            <>
              <ShortcutSection title={t('shortcuts.thisPage')} items={groups.local} />
              <div className="my-1.5 mx-2 h-px bg-border/60" />
            </>
          )}
          <ShortcutSection title={t('shortcuts.global')} items={groups.global} />
        </div>,
        document.body,
      )}
    </>
  )
}

function ShortcutSection({ title, items }: { title: string; items: ShortcutItem[] }) {
  const { t } = useTranslation()
  return (
    <div className="px-1">
      <div className="px-2.5 pt-1 pb-1 text-xs text-muted-foreground">{title}</div>
      <ul className="flex flex-col">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex items-center justify-between gap-3 px-2.5 py-1 text-sm text-foreground"
          >
            <span className="min-w-0 truncate">{t(item.labelKey)}</span>
            <ShortcutKeys keys={item.keys} className="shrink-0" />
          </li>
        ))}
      </ul>
    </div>
  )
}
