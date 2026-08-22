/**
 * 灯箱内缩放画布：适配视口后可 Ctrl/⌘+滚轮缩放、拖动平移。
 * 图片与 Mermaid SVG 共用，避免两套手势。
 */
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCcw } from 'lucide-react'
import {
  clampUserZoom,
  fitScale,
  readMediaNaturalSize,
  unlockSvgMaxSize,
  MEDIA_ZOOM_STEP,
} from '../lib/mediaZoom'

interface MediaZoomViewProps {
  children: ReactNode
  /** 图片/图表变化时重新测量（src 或 svg 字符串） */
  measureKey: string
  /** 点画布空白处（未拖动）关闭灯箱；点媒体本身不关 */
  onBackgroundClick?: () => void
}

export default function MediaZoomView({ children, measureKey, onBackgroundClick }: MediaZoomViewProps) {
  const { t } = useTranslation()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const mediaRef = useRef<HTMLDivElement>(null)
  const dragStateRef = useRef<{ startX: number; startY: number; sl: number; st: number; onMedia: boolean } | null>(null)

  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null)
  const [baseZoom, setBaseZoom] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [loadTick, setLoadTick] = useState(0)

  useEffect(() => {
    const media = mediaRef.current
    if (!media) return
    const img = media.querySelector('img')
    if (!img) return
    if (img.complete && img.naturalWidth > 0) {
      setLoadTick((n) => n + 1)
      return
    }
    const onLoad = () => setLoadTick((n) => n + 1)
    img.addEventListener('load', onLoad)
    return () => img.removeEventListener('load', onLoad)
  }, [measureKey])

  useEffect(() => {
    setNaturalSize(null)
    setZoom(1)
    let cancelled = false
    let attempts = 0

    const tryMeasure = () => {
      if (cancelled) return
      const scroller = scrollerRef.current
      const media = mediaRef.current
      if (!scroller || !media) return
      const size = readMediaNaturalSize(media)
      if (!size) {
        if (attempts++ < 40) requestAnimationFrame(tryMeasure)
        return
      }
      unlockSvgMaxSize(media)
      const base = fitScale(size.w, size.h, scroller.clientWidth, scroller.clientHeight)
      setNaturalSize(size)
      setBaseZoom(base)
      setZoom(1)
    }

    requestAnimationFrame(tryMeasure)
    return () => {
      cancelled = true
    }
  }, [measureKey, loadTick])

  useEffect(() => {
    if (!naturalSize) return
    const scroller = scrollerRef.current
    if (!scroller) return
    const ro = new ResizeObserver(() => {
      setBaseZoom(fitScale(naturalSize.w, naturalSize.h, scroller.clientWidth, scroller.clientHeight))
    })
    ro.observe(scroller)
    return () => ro.disconnect()
  }, [naturalSize])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const dir = e.deltaY > 0 ? -1 : 1
      setZoom((z) => clampUserZoom(z + dir * MEDIA_ZOOM_STEP))
    }
    scroller.addEventListener('wheel', onWheel, { passive: false })
    return () => scroller.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    const scroller = scrollerRef.current
    if (!scroller) return
    scroller.setPointerCapture(e.pointerId)
    const mediaBox = mediaRef.current?.getBoundingClientRect()
    const onMedia = Boolean(
      mediaBox &&
        e.clientX >= mediaBox.left &&
        e.clientX <= mediaBox.right &&
        e.clientY >= mediaBox.top &&
        e.clientY <= mediaBox.bottom,
    )
    dragStateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      sl: scroller.scrollLeft,
      st: scroller.scrollTop,
      onMedia,
    }
    scroller.style.cursor = 'grabbing'
  }
  const onPointerMove = (e: PointerEvent) => {
    const ds = dragStateRef.current
    if (!ds) return
    const scroller = scrollerRef.current
    if (!scroller) return
    scroller.scrollLeft = ds.sl - (e.clientX - ds.startX)
    scroller.scrollTop = ds.st - (e.clientY - ds.startY)
  }
  const onPointerUp = (e: PointerEvent) => {
    const ds = dragStateRef.current
    if (!ds) return
    const scroller = scrollerRef.current
    scroller?.releasePointerCapture?.(e.pointerId)
    if (scroller) scroller.style.cursor = 'grab'
    dragStateRef.current = null
    const moved = Math.hypot(e.clientX - ds.startX, e.clientY - ds.startY)
    if (!ds.onMedia && moved < 5) onBackgroundClick?.()
  }

  const totalScale = baseZoom * zoom
  const dispW = naturalSize ? Math.round(naturalSize.w * totalScale) : undefined
  const dispH = naturalSize ? Math.round(naturalSize.h * totalScale) : undefined
  const isZoomed = Math.abs(zoom - 1) > 0.001

  useEffect(() => {
    if (!dispW || !dispH) return
    const media = mediaRef.current
    if (media) unlockSvgMaxSize(media)
  }, [dispW, dispH, measureKey, loadTick])

  return (
    <div className="relative h-full min-h-0 flex flex-col">
      <div className="absolute top-3 left-4 z-10 flex items-center gap-2 pointer-events-none">
        <span className="text-[12px] tabular-nums text-white/85 bg-black/30 rounded-md px-2 py-1">
          {Math.round(zoom * 100)}%
        </span>
        <span className="text-[11px] text-white/55 hidden sm:inline">
          {t('lightbox.zoomHint')}
        </span>
      </div>
      {isZoomed && (
        <button
          type="button"
          onClick={() => setZoom(1)}
          className="absolute bottom-4 right-4 z-10 inline-flex items-center gap-1.5 text-[12px] text-white/80 hover:text-white bg-black/25 hover:bg-black/40 rounded-md px-2.5 py-1.5 transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" strokeWidth={1.75} />
          {t('lightbox.zoomReset')}
        </button>
      )}
      <div
        ref={scrollerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="flex-1 min-h-0 overflow-auto overscroll-auto select-none cursor-grab"
        style={{ touchAction: 'none' }}
      >
        <div className="w-max min-w-full min-h-full p-8 mx-auto flex items-center justify-center">
          <div
            ref={mediaRef}
            data-zoom-media
            className={`rounded-md bg-card shadow-2xl shrink-0 pointer-events-none ${
              dispW && dispH
                ? 'overflow-hidden [&_img]:w-full [&_img]:h-full [&_img]:max-w-none [&_img]:object-contain [&_svg]:!w-full [&_svg]:!h-full [&_svg]:!max-w-none [&_svg]:!max-h-none'
                : ''
            }`}
            style={dispW && dispH ? { width: dispW, height: dispH } : undefined}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
