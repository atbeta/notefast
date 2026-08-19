import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Maximize2, RotateCcw } from 'lucide-react'
import { nextMermaidId, renderMermaidSvg } from '../lib/mermaid'
import { CopyButton } from './ui'
import ImageLightbox from './ImageLightbox'

interface MermaidDiagramProps {
  code: string
  /** 语言标签文案，默认 mermaid */
  label?: string
  className?: string
}

/** 读取当前 <html data-theme>，并在主题切换时更新 */
function useDataTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof document === 'undefined') return 'light'
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
  })

  useEffect(() => {
    const el = document.documentElement
    const sync = () => {
      setTheme(el.getAttribute('data-theme') === 'dark' ? 'dark' : 'light')
    }
    sync()
    const obs = new MutationObserver(sync)
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])

  return theme
}

const MIN_ZOOM = 0.25
const MAX_ZOOM = 8
const VIEWPORT_FILL = 0.88 // 占视口比例
const ZOOM_STEP = 0.25

function clampZoom(z: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
}

/**
 * Mermaid 代码块：懒渲染 SVG；失败时展示错误 + 源码回退。
 * 供文档 BlockRenderer 与聊天气泡复用。
 */
export default function MermaidDiagram({
  code,
  label = 'mermaid',
  className = '',
}: MermaidDiagramProps) {
  const { t } = useTranslation()
  const theme = useDataTheme()
  const reactId = useId().replace(/:/g, '')
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [zoomed, setZoomed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setSvg(null)

    const trimmed = code.trim()
    if (!trimmed) {
      setLoading(false)
      setError(t('mermaid.emptyDiagram'))
      return
    }

    const id = `${nextMermaidId()}-${reactId}`
    renderMermaidSvg(trimmed, theme, id)
      .then((out) => {
        if (!cancelled) {
          setSvg(out)
          setLoading(false)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err)
          setError(msg || t('mermaid.renderFailed'))
          setSvg(null)
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [code, theme, reactId, t])

  return (
    <div className={`my-5 rounded-lg border border-border bg-muted/30 overflow-hidden ${className}`.trim()}>
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/60 border-b border-border">
        <span className="text-[11px] font-mono text-muted-foreground/80">{label}</span>
        <div className="flex items-center gap-1">
          {!loading && svg && (
            <button
              type="button"
              onClick={() => setZoomed(true)}
              className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded"
              aria-label={t('mermaid.zoom')}
            >
              <Maximize2 className="w-3.5 h-3.5" strokeWidth={1.75} />
            </button>
          )}
          <CopyButton
            text={code}
            className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded"
            ariaLabel="Copy diagram source"
            showText
          />
        </div>
      </div>

      {loading && (
        <div className="px-4 py-8 text-center text-[13px] text-muted-foreground">{t('mermaid.loading')}</div>
      )}

      {!loading && error && (
        <div className="p-4 space-y-3">
          <p className="text-[13px] text-destructive">{t('mermaid.renderFailedWith', { error })}</p>
          <pre className="overflow-x-auto text-[13px] font-mono leading-[1.6] text-foreground whitespace-pre-wrap">
            <code>{code}</code>
          </pre>
        </div>
      )}

      {!loading && svg && (
        <button
          type="button"
          onClick={() => setZoomed(true)}
          className="block w-full cursor-zoom-in"
          aria-label={t('mermaid.zoom')}
        >
          <div
            className="mermaid-diagram p-4 overflow-x-auto flex justify-center [&_svg]:max-w-full [&_svg]:h-auto"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </button>
      )}

      {zoomed && svg && (
        <ImageLightbox
          src=""
          alt={label}
          onClose={() => setZoomed(false)}
          closeOnInnerClick={false}
        >
          <MermaidZoomView svg={svg} onClose={() => setZoomed(false)} />
        </ImageLightbox>
      )}
    </div>
  )
}

/**
 * Lightbox 内的 mermaid 缩放视图：
 * - 打开后用 ResizeObserver 测量 SVG 自然尺寸，再算「适配视口 88%」的 baseZoom
 * - ctrl+滚轮调 zoom（0.25 档，0.25×–8×）
 * - 拖动平移（pointer events 接管 scroller）
 * - 仅 X 按钮 / 遮罩 / Esc 关闭（点击图内不关）
 */
function MermaidZoomView({
  svg,
  onClose,
}: {
  svg: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const dragStateRef = useRef<{ startX: number; startY: number; sl: number; st: number } | null>(null)

  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null)
  const [baseZoom, setBaseZoom] = useState(1) // 适配视口时的缩放比
  const [zoom, setZoom] = useState(1) // 用户当前缩放 = baseZoom × zoom 实际比例
  const [measured, setMeasured] = useState(false)

  // 打开后测量自然尺寸 + 计算 baseZoom
  useEffect(() => {
    if (measured) return
    const scroller = scrollerRef.current
    if (!scroller) return
    const svgEl = scroller.querySelector('svg')
    if (!svgEl) return
    const r = svgEl.getBoundingClientRect()
    if (!r.width || !r.height) {
      const t = window.setTimeout(() => { /* re-run via effect dep */ }, 60)
      return () => window.clearTimeout(t)
    }
    const cw = scroller.clientWidth
    const ch = scroller.clientHeight
    const base = Math.min((cw * VIEWPORT_FILL) / r.width, (ch * VIEWPORT_FILL) / r.height, 1)
    setNaturalSize({ w: r.width, h: r.height })
    setBaseZoom(Math.max(MIN_ZOOM, base))
    setZoom(1)
    setMeasured(true)
  }, [measured, svg])

  // viewport resize 时重算 baseZoom（保持图始终适配）
  useEffect(() => {
    if (!measured || !naturalSize) return
    const scroller = scrollerRef.current
    if (!scroller) return
    const ro = new ResizeObserver(() => {
      const cw = scroller.clientWidth
      const ch = scroller.clientHeight
      const base = Math.min((cw * VIEWPORT_FILL) / naturalSize.w, (ch * VIEWPORT_FILL) / naturalSize.h, 1)
      setBaseZoom(Math.max(MIN_ZOOM, base))
    })
    ro.observe(scroller)
    return () => ro.disconnect()
  }, [measured, naturalSize])

  // Ctrl+wheel：原生非 passive 监听，才能 preventDefault
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const dir = e.deltaY > 0 ? -1 : 1
      setZoom((z) => clampZoom(z + dir * ZOOM_STEP))
    }
    scroller.addEventListener('wheel', onWheel, { passive: false })
    return () => scroller.removeEventListener('wheel', onWheel)
  }, [])

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 拖动平移：pointer events 接管（防止文本选中和原生 drag）
  const onPointerDown = (e: React.PointerEvent) => {
    // 按钮上的点击不触发拖动（比如重置按钮）
    if ((e.target as HTMLElement).closest('button')) return
    const scroller = scrollerRef.current
    if (!scroller) return
    scroller.setPointerCapture(e.pointerId)
    dragStateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      sl: scroller.scrollLeft,
      st: scroller.scrollTop,
    }
    scroller.style.cursor = 'grabbing'
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const ds = dragStateRef.current
    if (!ds) return
    const scroller = scrollerRef.current
    if (!scroller) return
    scroller.scrollLeft = ds.sl - (e.clientX - ds.startX)
    scroller.scrollTop = ds.st - (e.clientY - ds.startY)
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragStateRef.current) return
    const scroller = scrollerRef.current
    scroller?.releasePointerCapture?.(e.pointerId)
    if (scroller) scroller.style.cursor = 'grab'
    dragStateRef.current = null
  }

  const totalScale = baseZoom * zoom
  const dispW = naturalSize ? Math.round(naturalSize.w * totalScale) : undefined
  const dispH = naturalSize ? Math.round(naturalSize.h * totalScale) : undefined
  const isZoomed = Math.abs(zoom - 1) > 0.001

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="absolute top-3 left-4 z-10 flex items-center gap-2 pointer-events-none">
        <span className="text-[12px] tabular-nums text-white/85 bg-black/30 rounded-md px-2 py-1">
          {Math.round(totalScale * 100)}%
        </span>
        <span className="text-[11px] text-white/55 hidden sm:inline">
          {t('mermaid.zoomHint')}
        </span>
      </div>
      {isZoomed && (
        <button
          type="button"
          onClick={() => setZoom(1)}
          className="absolute bottom-4 right-4 z-10 inline-flex items-center gap-1.5 text-[12px] text-white/80 hover:text-white bg-black/25 hover:bg-black/40 rounded-md px-2.5 py-1.5 transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" strokeWidth={1.75} />
          {t('mermaid.zoomReset')}
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
          {dispW && dispH ? (
            <div
              className="rounded-md bg-white dark:bg-[#1e1e1e] shadow-2xl shrink-0"
              style={{ width: dispW, height: dispH }}
            >
              <div
                className="[&_svg]:w-full [&_svg]:h-full [&_svg]:max-w-none pointer-events-none"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </div>
          ) : (
            <div
              className="rounded-md bg-white dark:bg-[#1e1e1e] shadow-2xl shrink-0"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          )}
        </div>
      </div>
    </div>
  )
}