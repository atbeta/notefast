import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Maximize2, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react'
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
  // lightbox 内继续缩放倍数（1x 起；基于当前大小继续放大，密图 200% 不够时用）
  const [lightboxZoom, setLightboxZoom] = useState(1)

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
            setLightboxZoom(1)
          }}
        >
          {/* 放大查看：SVG 全尺寸展示（不压缩）+ 可继续缩放，密图也能看清 */}
          <div className="flex flex-col h-full min-h-0" onClick={(e) => e.stopPropagation()}>
            {/* 缩放控制条：− / 档位 / + / 重置（基于当前大小继续放大） */}
            <div className="flex items-center justify-center gap-3 px-4 py-2.5 shrink-0">
              <button
                type="button"
                onClick={() => setLightboxZoom((z) => Math.max(1, z - 0.5))}
                disabled={lightboxZoom <= 1}
                className="inline-flex items-center justify-center w-8 h-8 rounded-md text-white/80 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30"
                aria-label={t('mermaid.zoomOut')}
              >
                <ZoomOut className="w-4 h-4" strokeWidth={1.75} />
              </button>
              <span className="text-[12.5px] tabular-nums text-white/90 min-w-[3.5rem] text-center">
                {Math.round(lightboxZoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() => setLightboxZoom((z) => Math.min(4, z + 0.5))}
                disabled={lightboxZoom >= 4}
                className="inline-flex items-center justify-center w-8 h-8 rounded-md text-white/80 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30"
                aria-label={t('mermaid.zoomIn')}
              >
                <ZoomIn className="w-4 h-4" strokeWidth={1.75} />
              </button>
              {lightboxZoom !== 1 && (
                <button
                  type="button"
                  onClick={() => setLightboxZoom(1)}
                  className="inline-flex items-center gap-1 text-[12px] text-white/70 hover:text-white transition-colors px-2 py-1 rounded-md hover:bg-white/10"
                >
                  <RotateCcw className="w-3.5 h-3.5" strokeWidth={1.75} />
                  {t('mermaid.zoomReset')}
                </button>
              )}
            </div>
            <div className="mermaid-zoom overflow-auto flex-1 min-h-0 w-full flex justify-center p-6">
              <div
                className="[&_svg]:max-w-none [&_svg]:h-auto shadow-2xl rounded-md bg-white dark:bg-[#1e1e1e] p-4 self-start"
                style={{ zoom: lightboxZoom }}
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </div>
          </div>
        </ImageLightbox>
      )}
    </div>
  )
}
