import { useEffect, useRef, useState } from 'react'

interface AiGhostOverlayProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  content: string
  ghostText: string
  visible: boolean
}

export default function AiGhostOverlay({ textareaRef, content, ghostText, visible }: AiGhostOverlayProps) {
  const [pos, setPos] = useState<{ left: number; top: number; lineHeight: number } | null>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const ta = textareaRef.current
    if (!ta || !visible || !ghostText) {
      setPos(null)
      return
    }

    const taRect = ta.getBoundingClientRect()
    const mirror = mirrorRef.current
    if (!mirror) return

    // 把 textarea 内容拷贝到 mirror div 里，在末尾插入标记 span
    const selectionEnd = ta.selectionEnd
    const textBeforeCursor = content.slice(0, selectionEnd)

    // 获取样式用于 mirror
    const style = getComputedStyle(ta)

    mirror.style.font = style.font
    mirror.style.fontSize = style.fontSize
    mirror.style.fontFamily = style.fontFamily
    mirror.style.lineHeight = style.lineHeight
    mirror.style.paddingTop = style.paddingTop
    mirror.style.paddingLeft = style.paddingLeft
    mirror.style.paddingRight = style.paddingRight
    mirror.style.width = style.width
    mirror.style.whiteSpace = 'pre-wrap'
    mirror.style.wordBreak = 'break-word'
    mirror.style.overflowWrap = 'break-word'
    mirror.style.boxSizing = 'border-box'

    mirror.innerHTML = escapeHtml(textBeforeCursor) + '<span id="ai-ghost-marker"></span>'

    const marker = mirror.querySelector('#ai-ghost-marker')
    if (marker) {
      const markerRect = marker.getBoundingClientRect()
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6

      setPos({
        left: markerRect.left - taRect.left,
        top: markerRect.top - taRect.top,
        lineHeight,
      })
    }
  }, [content, ghostText, visible, textareaRef])

  if (!pos || !visible || !ghostText) return null

  return (
    <>
      <div
        aria-hidden
        ref={mirrorRef}
        className="absolute left-0 top-0 right-0 opacity-0 pointer-events-none whitespace-pre-wrap break-words"
        style={{
          position: 'fixed',
          left: '-9999px',
          top: '-9999px',
        }}
      />
      <span
        className="absolute pointer-events-none animate-pulse whitespace-pre-wrap"
        style={{
          left: pos.left,
          top: pos.top,
          fontSize: '14px',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          lineHeight: `${pos.lineHeight}px`,
          color: 'var(--color-text-muted, #94a3b8)',
          opacity: 0.5,
        }}
      >
        {ghostText}
      </span>
    </>
  )
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
