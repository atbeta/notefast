/**
 * 编辑器选区气泡（桌面端 v1）：非空选区上方浮出「问 AI / 改写」。
 *
 * - 手写 popover 模式（portal → fixed z-[80] → Esc/外部 mousedown/scroll/resize 关闭）
 * - 关键：容器 onMouseDown preventDefault——否则点击按钮瞬间编辑器失焦、选区塌陷，
 *   blur 上报 null 会让气泡在 click 前卸载
 * - 未配置 chat 模型时整个气泡不出（问 AI / 改写都必然失败，能力探测与 AIChatPanel 同款）
 * - 桌面限定（<sm 不渲染，matchMedia gate，与 BlockSurface 的 sm: 决策一致；iOS 选区坑不做）
 * - 「续写」已有 Mod+Enter 入口，不进气泡
 * - 改写流式期间钉在原选区位置显示「生成中…/停止」，done/error/停止后由父组件收起
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Loader2, Sparkles, Wand2 } from 'lucide-react'
import { dispatchAskAi } from '../../lib/askAi'
import { useAiCapabilities } from '../../hooks/useAiCapabilities'
import { usePopoverDismiss } from '../../hooks/usePopoverDismiss'
import type { SelectionAnchor, SelectionRect } from './cm/selectionReport'

/** 预填引用的长度上限（与 BlockSurface 一致），避免整段长文塞进输入框 */
const QUOTE_MAX = 600

/** 桌面判定（与 Tailwind sm 断点一致） */
const DESKTOP_MQ = '(min-width: 640px)'

const btnCls =
  'flex items-center gap-1.5 px-2 py-1 text-[13px] rounded-md text-foreground hover:bg-accent transition-colors'

interface SelectionBubbleProps {
  /** 当前非空选区锚点（null = 无选区/已收起） */
  anchor: SelectionAnchor | null
  /** 改写流式进行中（气泡切「生成中/停止」态） */
  refining: boolean
  /** 流式期间的钉住位置（原选区矩形） */
  refineRect: SelectionRect | null
  onRefine: (anchor: SelectionAnchor) => void
  onStopRefine: () => void
  onDismiss: () => void
}

export default function SelectionBubble({
  anchor,
  refining,
  refineRect,
  onRefine,
  onStopRefine,
  onDismiss,
}: SelectionBubbleProps) {
  const { t } = useTranslation()
  const panelRef = useRef<HTMLDivElement>(null)
  const [desktop, setDesktop] = useState(() => window.matchMedia(DESKTOP_MQ).matches)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  /** chat 能力：null=探测中（不出气泡），false=未配置（不出气泡） */
  // 复用 useAiCapabilities 单例探测，避免 SelectionBubble / AIChatPanel / EditorToolbar
  // 各自 fetch 一次；都订阅同一个 /ai/capabilities 响应
  const ai = useAiCapabilities()
  const chatOk = ai.chat

  const active = refining || anchor !== null
  const rect = refining ? refineRect : (anchor?.rect ?? null)

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_MQ)
    const onChange = () => setDesktop(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // 定位：锚点上方居中，近顶翻转下方，窗口边界 clamp
  useLayoutEffect(() => {
    if (!desktop || !active || !rect) {
      setPos(null)
      return
    }
    const pad = 8
    const gap = 8
    const el = panelRef.current
    const w = el?.offsetWidth ?? 200
    const h = el?.offsetHeight ?? 36
    const cx = rect.left + (rect.right - rect.left) / 2
    const left = Math.max(pad, Math.min(cx - w / 2, window.innerWidth - w - pad))
    let top = rect.top - h - gap
    if (top < pad) top = Math.min(rect.bottom + gap, window.innerHeight - h - pad)
    setPos({ top, left })
  }, [desktop, active, rect, refining])

  // 关闭通道：Esc（流式期间 = 停止）/ 外部 mousedown / scroll / resize；
  // 流式期间全部忽略（停止按钮保持可达；外部编辑会经 onChange 中断流）
  usePopoverDismiss(active, {
    onClose: onDismiss,
    onEscape: () => {
      if (refining) onStopRefine()
      else onDismiss()
    },
    ignoreOutsideClick: refining,
    closeOnScroll: true,
    closeOnResize: true,
  }, panelRef)

  if (!desktop || !active || !rect || chatOk !== true) return null

  const handleAskAi = () => {
    if (!anchor) return
    const quote = anchor.text.trim()
    if (!quote) return
    dispatchAskAi({ quote: quote.length > QUOTE_MAX ? `${quote.slice(0, QUOTE_MAX)}…` : quote })
    onDismiss()
  }

  return createPortal(
    <div
      ref={panelRef}
      role="toolbar"
      aria-label={t('selectionBubble.label')}
      className="fixed z-[80] flex items-center gap-0.5 p-1 rounded-lg border border-border bg-popover text-popover-foreground shadow-[var(--shadow-floating)] animate-fade-in"
      style={{ top: pos?.top ?? -10000, left: pos?.left ?? -10000 }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {refining ? (
        <>
          <span className="flex items-center gap-1.5 px-2 py-1 text-[13px] text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} />
            {t('selectionBubble.generating')}
          </span>
          <button type="button" onClick={onStopRefine} className={btnCls}>
            {t('selectionBubble.stop')}
          </button>
        </>
      ) : (
        anchor && (
          <>
            <button type="button" onClick={handleAskAi} className={btnCls}>
              <Sparkles className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
              {t('selectionBubble.askAi')}
            </button>
            <button type="button" onClick={() => onRefine(anchor)} className={btnCls}>
              <Wand2 className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
              {t('selectionBubble.refine')}
            </button>
          </>
        )
      )}
    </div>,
    document.body,
  )
}
