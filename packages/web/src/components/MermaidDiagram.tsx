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
  // lightbox 视图状态
  const [fitScale, setFitScale] = useState<number | null>(null) // 适配视口的基准缩放（SVG 自然尺寸 → 视口）
  const [userZoom, setUserZoom] = useState(1) // 用户 Ctrl+滚轮额外缩放（1x 起）
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
            fitScale={fitScale}
            userZoom={userZoom}
            wrapRef={zoomWrapRef}
            fitMeasuredRef={fitMeasured}
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
 * Lightbox 内 mermaid 缩放视图：
 * - 默认适配视口（SVG 自然尺寸缩放到 85% 视口，保证全屏大小一致）
 * - Ctrl+滚轮缩放（围绕视口中心，1x–8x）
 * - 点击遮罩关闭（与图片 lightbox 一致）
 */
function MermaidZoomView({
  svg,
  fitScale,
  userZoom,
  wrapRef,
  fitMeasuredRef,
  onFit,
  onUserZoom,
  onClose,
}: {
  svg: string
  fitScale: number | null
  userZoom: number
  wrapRef: React.RefObject<HTMLDivElement | null>
  fitMeasuredRef: React.MutableRefObject<boolean>
  onFit: (s: number) => void
  onUserZoom: (fn: (z: number) => number) => void
  onClose: () => void
}) {
  const { t } = useTranslation()

  // 打开/尺寸变化后测量 SVG 自然尺寸 → 算适配视口的 fitScale
  useEffect(() => {
    if (fitScale !== null || fitMeasuredRef.current) return
    const root = wrapRef.current
    if (!root) return
    const svgEl = root.querySelector('svg')
    const vp = root.parentElement?.parentElement
    if (!svgEl || !vp) return
    // SVG 自然尺寸：优先取 width/height 属性，缺则 getBBox
    const natW = svgEl.getAttribute('width') ? parseFloat(svgEl.getAttribute('width')!) : svgEl.getBBox().width
    const natH = svgEl.getAttribute('height') ? parseFloat(svgEl.getAttribute('height')!) : svgEl.getBBox().height
    if (!natW || !natH) { fitMeasuredRef.current = true; return }
    const vpW = vp.clientWidth || window.innerWidth
    const vpH = vp.clientHeight || window.innerHeight
    // 85% 视口内适配（宽高取小，保证整图可见）
    const s = Math.min((vpW * 0.85) / natW, (vpH * 0.85) / natH)
    onFit(Math.min(Math.max(s, 0.1), 5))
    fitMeasuredRef.current = true
  }, [fitScale, fitMeasuredRef, onFit, wrapRef])

  // Ctrl+滚轮：围绕视口中心缩放
  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey) return
    e.preventDefault()
    const delta = e.deltaY > 0 ? -1 : 1
    onUserZoom((z) => Math.min(8, Math.max(1, z + delta * 0.25)))
  }

  const scale = fitScale == null ? 1 : fitScale * userZoom

  return (
    <div
      className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden"
      onClick={onClose}
    >
      {/* 缩放提示（右上角） */}
      <div className="absolute top-3 right-4 z-10 flex items-center gap-2">
        <span className="text-[12px] tabular-nums text-white/85 bg-black/30 rounded-md px-2 py-1">
          {Math.round(scale * 100)}%
        </span>
      </div>
      {scale !== (fitScale ?? 1) && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onUserZoom(() => 1) }}
          className="absolute bottom-4 right-4 z-10 inline-flex items-center gap-1.5 text-[12px] text-white/80 hover:text-white bg-black/25 hover:bg-black/40 rounded-md px-2.5 py-1.5 transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" strokeWidth={1.75} />
          {t('mermaid.zoomReset')}
        </button>
      )}
      <div
        ref={wrapRef}
        onWheel={onWheel}
        onClick={(e) => e.stopPropagation()}
        className="[&_svg]:max-w-none"
        style={{
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
          transition: 'transform 0.08s ease-out',
        }}
      >
        <div
          className="rounded-md bg-white dark:bg-[#1e1e1e] shadow-2xl"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  )
}
