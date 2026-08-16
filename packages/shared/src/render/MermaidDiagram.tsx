import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { nextMermaidId, renderMermaidSvg } from '../lib/mermaid'
import { CopyButton } from '../ui'

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
        <CopyButton
          text={code}
          className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded"
          ariaLabel="Copy diagram source"
          showText
        />
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
        <div
          className="mermaid-diagram p-4 overflow-x-auto flex justify-center [&_svg]:max-w-full [&_svg]:h-auto"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </div>
  )
}
