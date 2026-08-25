/**
 * 阅读 / 预览 / 分享共用的代码围栏：行号与正文同一套 DOM，默认横向滚动。
 * 复制走原始源码，不含行号。
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WrapText } from 'lucide-react'
import { highlightCode } from '../lib/highlight'
import { escapeHtml, splitHighlightedLines } from '../lib/codeLines'
import { useCodeWrap, writeCodeWrap } from '../hooks/useCodeWrap'
import { CopyButton } from './ui'

export function CodeFenceView({
  code,
  language,
  id,
  compact = false,
}: {
  code: string
  language: string
  id?: string
  compact?: boolean
}) {
  const { t } = useTranslation()
  const wrap = useCodeWrap()
  const [highlighted, setHighlighted] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setHighlighted(null)
    if (language && code) {
      highlightCode(code, language)
        .then((html) => { if (!cancelled && html) setHighlighted(html) })
        .catch(() => {})
    }
    return () => { cancelled = true }
  }, [code, language])

  const srcLines = useMemo(() => code.split('\n'), [code])
  const htmlLines = useMemo(() => {
    if (!highlighted) return srcLines.map(escapeHtml)
    const parts = splitHighlightedLines(highlighted)
    return srcLines.map((_, i) => parts[i] ?? escapeHtml(srcLines[i] ?? ''))
  }, [highlighted, srcLines])

  const digits = String(Math.max(srcLines.length, 1)).length

  return (
    <div
      id={id}
      className={compact ? 'chat-code-block' : 'scroll-mt-20 my-5 rounded-lg border border-border bg-muted/30 overflow-hidden'}
    >
      <div className={compact ? 'chat-code-block-bar' : 'flex items-center justify-between px-3 py-1.5 bg-muted/60 border-b border-border'}>
        <span className={compact ? 'chat-code-lang' : 'text-xs font-mono text-muted-foreground/80'}>
          {language || 'text'}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => writeCodeWrap(!wrap)}
            aria-pressed={wrap}
            aria-label={wrap ? t('codeFence.scroll') : t('codeFence.wrap')}
            title={wrap ? t('codeFence.scroll') : t('codeFence.wrap')}
            className={compact
              ? `chat-code-copy ${wrap ? 'text-foreground' : ''}`
              : `inline-flex items-center justify-center w-6 h-6 rounded-md transition-colors ${
                  wrap
                    ? 'text-primary bg-primary/12 hover:bg-primary/15'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                }`}
          >
            <WrapText className={compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} strokeWidth={1.75} />
          </button>
          <CopyButton
            text={code}
            className={compact
              ? 'chat-code-copy'
              : 'inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded-md'}
            ariaLabel={t('copyBtn.copy')}
            showText={!compact}
            iconClassName={compact ? 'w-3 h-3' : 'w-3.5 h-3.5'}
          />
        </div>
      </div>
      <pre
        className={`code-fence-body ${wrap ? 'is-wrap' : ''} ${compact ? '' : 'code-block-body text-base font-mono leading-[1.6] text-foreground'}`}
        style={{ ['--code-gutter-ch' as string]: String(digits) }}
      >
        <code className={language ? `hljs language-${language}` : ''}>
          {htmlLines.map((html, i) => (
            <span key={i} className="code-line">
              <span className="code-line-num" aria-hidden="true">{i + 1}</span>
              <span className="code-line-src" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
            </span>
          ))}
        </code>
      </pre>
    </div>
  )
}
