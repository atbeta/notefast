import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * 成组瞬时 Tooltip（Radix 风格 skip-delay）：
 * 首个 300ms 延迟出现；任一 tooltip 关闭后的 800ms 窗口内，后续 0 延迟即时出现——
 * 鼠标横扫图标按钮组时不拖沓。仅处理鼠标交互（键盘可访问性由按钮自身的 aria-label 承担）。
 */
const SHOW_DELAY_MS = 300
const GROUP_WINDOW_MS = 800
let lastHideAt = 0

export function Tooltip({
  label,
  children,
  className = '',
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [style, setStyle] = useState<{ left: number; top: number; transform: string } | null>(null)

  const cancelTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const show = () => {
    const el = anchorRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const above = r.top >= 40 // 顶部空间不足时翻到下方
    setStyle({
      left: Math.min(Math.max(r.left + r.width / 2, 56), window.innerWidth - 56),
      top: above ? r.top - 6 : r.bottom + 6,
      transform: above ? 'translate(-50%, -100%)' : 'translateX(-50%)',
    })
  }

  const handleEnter = () => {
    cancelTimer()
    const delay = Date.now() - lastHideAt < GROUP_WINDOW_MS ? 0 : SHOW_DELAY_MS
    timerRef.current = setTimeout(show, delay)
  }

  const hide = () => {
    cancelTimer()
    setStyle((cur) => {
      if (cur) lastHideAt = Date.now()
      return null
    })
  }

  return (
    <span
      ref={anchorRef}
      className={`inline-flex ${className}`}
      onMouseEnter={handleEnter}
      onMouseLeave={hide}
      onMouseDown={hide}
    >
      {children}
      {style &&
        createPortal(
          <span
            role="tooltip"
            className="pointer-events-none fixed z-tooltip max-w-[min(280px,80vw)] whitespace-normal break-words rounded-md bg-ink px-2.5 py-1.5 text-left text-[11px] font-medium leading-relaxed text-ink-foreground shadow-floating"
            style={style}
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  )
}
