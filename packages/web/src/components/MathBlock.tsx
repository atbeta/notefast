import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { renderMathToHtml } from '../lib/katex'
import { CopyButton } from './ui'

/**
 * 块级公式（```math 或独占行 $$）：懒渲染 KaTeX；失败时展示错误 + 源码回退。
 * 外壳结构与 MermaidDiagram 对齐（语言标签 + 复制源码）。
 */
export default function MathBlock({ code }: { code: string }) {
  const { t } = useTranslation()
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setHtml(null)

    const trimmed = code.trim()
    if (!trimmed) {
      setLoading(false)
      setError(t('math.emptyMath'))
      return
    }

    renderMathToHtml(trimmed, true)
      .then((out) => {
        if (!cancelled) {
          setHtml(out)
          setLoading(false)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err)
          setError(msg || t('math.renderFailed'))
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [code, t])

  return (
    <div className="my-5 rounded-lg border border-border bg-muted/30 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/60 border-b border-border">
        <span className="text-xs font-mono text-muted-foreground/80">math</span>
        <CopyButton
          text={code}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded-md"
          ariaLabel="Copy math source"
          showText
        />
      </div>

      {loading && (
        <div className="px-4 py-8 text-center text-base text-muted-foreground">{t('math.loading')}</div>
      )}

      {!loading && error && (
        <div className="p-4 space-y-3">
          <p className="text-base text-destructive">{t('math.renderFailedWith', { error })}</p>
          <pre className="overflow-x-auto text-base font-mono leading-[1.6] text-foreground whitespace-pre-wrap">
            <code>{code}</code>
          </pre>
        </div>
      )}

      {!loading && html && (
        <div
          className="p-4 overflow-x-auto flex justify-center [&_.katex-display]:m-0"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  )
}

/**
 * 行内公式 $...$：渲染前显示源码文本，失败静默回退源码（不打断阅读流）。
 * tex 为分隔符内部内容，raw 为含 $ 的原文。
 */
export function MathInline({ tex, raw }: { tex: string; raw: string }) {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    renderMathToHtml(tex, false)
      .then((out) => {
        if (!cancelled) setHtml(out)
      })
      .catch(() => {
        if (!cancelled) setHtml(null)
      })
    return () => {
      cancelled = true
    }
  }, [tex])

  if (!html) return <>{raw}</>
  // katex trust:false 输出无用户 HTML，可安全注入（见 lib/katex.ts）
  return <span dangerouslySetInnerHTML={{ __html: html }} />
}
