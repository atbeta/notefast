/**
 * ScrollEdgeButtons — 阅读态浮动「回顶 / 到底」按钮
 *
 * 挂在文档滚动容器的相对定位父级内（不随内容滚走、天然避开右栏/AI 面板）：
 * - 回顶：scrollTop 超过阈值后出现
 * - 到底：距底部超过阈值后出现（长文档才有意义，短文档两个都不出）
 * 阈值判定在滚动与内容高度变化（ResizeObserver）时更新，rAF 合帧。
 */
import { useEffect, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { Tooltip } from './ui'

const THRESHOLD = 600

export default function ScrollEdgeButtons({ containerRef }: { containerRef: RefObject<HTMLElement | null> }) {
  const { t } = useTranslation()
  const [showUp, setShowUp] = useState(false)
  const [showDown, setShowDown] = useState(false)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let raf = 0
    const update = () => {
      raf = 0
      setShowUp(el.scrollTop > THRESHOLD)
      setShowDown(el.scrollHeight - el.scrollTop - el.clientHeight > THRESHOLD)
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(update) }
    update()
    el.addEventListener('scroll', schedule, { passive: true })
    // 内容高度变化（文档加载 / 图片载入 / demo 缩放）同样影响「距底部」判定
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', schedule)
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [containerRef])

  if (!showUp && !showDown) return null

  const scrollTo = (top: number) =>
    containerRef.current?.scrollTo({ top, behavior: 'smooth' })

  const btnClass =
    'w-8 h-8 inline-flex items-center justify-center rounded-full border border-border bg-card/95 text-muted-foreground hover:text-foreground hover:bg-accent shadow-floating backdrop-blur-sm transition-colors animate-fade-in'

  return (
    <div className="absolute bottom-6 right-6 z-sticky flex flex-col gap-2 print:hidden">
      {showUp && (
        <Tooltip label={t('doc.scrollToTop')}>
          <button
            type="button"
            aria-label={t('doc.scrollToTop')}
            onClick={() => scrollTo(0)}
            className={btnClass}
          >
            <ArrowUp className="w-4 h-4" strokeWidth={1.75} />
          </button>
        </Tooltip>
      )}
      {showDown && (
        <Tooltip label={t('doc.scrollToBottom')}>
          <button
            type="button"
            aria-label={t('doc.scrollToBottom')}
            onClick={() => scrollTo(containerRef.current?.scrollHeight ?? 0)}
            className={btnClass}
          >
            <ArrowDown className="w-4 h-4" strokeWidth={1.75} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}
