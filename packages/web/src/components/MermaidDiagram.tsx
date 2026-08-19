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
  // lightbox 视图状态：SVG 自然尺寸 + 适配倍数 + 用户额外缩放
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null)
  const [fitScale, setFitScale] = useState<number | null>(null)
  const [userZoom, setUserZoom] = useState(1)
  const zoomWrapRef = useRef<HTMLDivElement>(null)
  const fitMeasured = useRef(false)

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
          onClose={() => {
            setZoomed(false)
            setUserZoom(1)
            setFitScale(null)
            fitMeasured.current = false
          }}
        >
          <MermaidZoomView
            svg={svg}
            naturalSize={naturalSize}
            fitScale={fitScale}
            userZoom={userZoom}
            wrapRef={zoomWrapRef}
            fitMeasuredRef={fitMeasured}
            onNaturalSize={setNaturalSize}
            onFit={(s) => setFitScale(s)}
            onUserZoom={setUserZoom}
            onClose={() => setZoomed(false)}
          />
        </ImageLightbox>
      )}
    </div>
  )
}

/**
 * Lightbox 内 mermaid 缩放视图（纯布局尺寸，无 transform/zoom 裁剪问题）：
 * - 默认适配视口：把 SVG 自然尺寸缩放到 85% 视口，保证全屏大小一致
 * - Ctrl+滚轮缩放：通过显式宽高让实际内容变大，配合可滚动容器看全图
 * - 点击遮罩关闭（与图片 lightbox 一致）
 */
function MermaidZoomView({
  svg,
  naturalSize,
  fitScale,
  userZoom,
  wrapRef,
  fitMeasuredRef,
  onNaturalSize,
  onFit,
  onUserZoom,
  onClose,
}: {
  svg: string
  naturalSize: { w: number; h: number } | null
  fitScale: number | null
  userZoom: number
  wrapRef: React.RefObject<HTMLDivElement | null>
  fitMeasuredRef: React.MutableRefObject<boolean>
  onNaturalSize: (s: { w: number; h: number }) => void
  onFit: (s: number) => void
  onUserZoom: (fn: (z: number) => number) => void
  onClose: () => void
}) {
  const { t } = useTranslation()

  // 打开后测量 SVG 自然尺寸 + 算适配视口的 fitScale
  useEffect(() => {
    if (naturalSize !== null || fitMeasuredRef.current) return
    const root = wrapRef.current
    if (!root) return
    const svgEl = root.querySelector('svg')
    const vp = root.parentElement?.parentElement
    if (!svgEl || !vp) return
    const r = svgEl.getBoundingClientRect()
    if (!r.width || !r.height) {
      const t = window.setTimeout(() => { fitMeasuredRef.current = false }, 60)
      return () => window.clearTimeout(t)
    }
    const vpW = vp.clientWidth || window.innerWidth
    const vpH = vp.clientHeight || window.innerHeight
    const s = Math.min((vpW * 0.85) / r.width, (vpH * 0.85) / r.height)
    onNaturalSize({ w: r.width, h: r.height })
    onFit(Math.min(Math.max(s, 0.05), 8))
    fitMeasuredRef.current = true
  }, [naturalSize, fitMeasuredRef, onNaturalSize, onFit, wrapRef])

  // Ctrl+滚轮：放大 / 缩小（0.25 档）
  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey) return
    e.preventDefault()
    const delta = e.deltaY > 0 ? -1 : 1
    onUserZoom((z) => Math.min(8, Math.max(1, z + delta * 0.25)))
  }

  // 实际展示尺寸 = 自然尺寸 × 适配 × 用户缩放
  const totalScale = fitScale == null ? 1 : fitScale * userZoom
  const dispW = naturalSize ? Math.round(naturalSize.w * totalScale) : undefined
  const dispH = naturalSize ? Math.round(naturalSize.h * totalScale) : undefined

  return (
    <div className="relative flex-1 min-h-0 flex flex-col" onClick={onClose}>
      <div className="absolute top-3 left-4 z-10 flex items-center gap-2">
        <span className="text-[12px] tabular-nums text-white/85 bg-black/30 rounded-md px-2 py-1">
          {Math.round(totalScale * 100)}%
        </span>
      </div>
      {userZoom > 1 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onUserZoom(() => 1) }}
          className="absolute bottom-4 right-4 z-10 inline-flex items-center gap-1.5 text-[12px] text-white/80 hover:text-white bg-black/25 hover:bg-black/40 rounded-md px-2.5 py-1.5 transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" strokeWidth={1.75} />
          {t('mermaid.zoomReset')}
        </button>
      )}
      {/* 可滚动视口：内容尺寸变大时出现滚动条，可看放大后的全图 */}
      <div
        ref={wrapRef}
        onWheel={onWheel}
        onClick={(e) => e.stopPropagation()}
        className="flex-1 min-h-0 overflow-auto overscroll-contain"
      >
        <div className="min-w-full min-h-full w-max p-8">
          {natSvg(svg, dispW, dispH)}
        </div>
      </div>
    </div>
  )
}

// 渲染 SVG：有显式尺寸时用 width/height 撑大内容（让滚动条生效）；
// 无尺寸（首次测量前）时保持 SVG 自然尺寸，供测量自然宽高。
function natSvg(svg: string, width?: number, height?: number): React.ReactElement {
  return (
    <div
      className="rounded-md bg-white dark:bg-[#1e1e1e] shadow-2xl"
      style={width && height ? { width, height } : undefined}
    >
      {width && height ? (
        <div
          className="[&_svg]:w-full [&_svg]:h-full [&_svg]:max-w-none"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div
          className="[&_svg]:max-w-none"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </div>
  )
}
