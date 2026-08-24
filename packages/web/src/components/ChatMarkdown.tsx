import { useState, useEffect, createElement, memo, cloneElement, type ReactNode, Children, isValidElement } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { highlightCode } from '../lib/highlight'
import { classifyChatMath } from '../lib/chatMath'
import { splitCiteParts } from '../lib/chatCites'
import MermaidDiagram from './MermaidDiagram'
import MathBlock, { MathInline } from './MathBlock'
import { LightboxImg } from './ImageLightbox'
import { CopyButton, Tooltip } from './ui'
import { useTranslation } from 'react-i18next'
import i18next from '../i18n'
import { resolveMarkdownHref } from '../lib/markdownHref'

interface ChatMarkdownProps {
  content: string
  className?: string
  /** 正文 [n] 渲染为上标的上限（与当前回答 citations.length 对齐）；0 则不转换 */
  maxCite?: number
}

function citeNodes(text: string, maxCite: number): ReactNode {
  const parts = splitCiteParts(text, maxCite)
  if (parts.length === 1 && parts[0]!.type === 'text') return text
  return parts.map((p, i) =>
    p.type === 'text'
      ? p.value
      : (
        <a key={`c${i}`} className="chat-cite" href={`#chat-cite-${p.n}`}>
          {p.n}
        </a>
      ),
  )
}

function mapCited(node: ReactNode, maxCite: number): ReactNode {
  if (maxCite < 1) return node
  return Children.map(node, (child) => {
    if (typeof child === 'string') return citeNodes(child, maxCite)
    if (typeof child === 'number') return child
    if (!isValidElement<{ children?: ReactNode }>(child)) return child
    const t = child.type
    if (t === 'code' || t === 'pre' || t === 'a') return child
    if (child.props.children == null) return child
    return cloneElement(child, undefined, mapCited(child.props.children, maxCite))
  })
}

/** 聊天气泡内的 Markdown 渲染（GFM + 代码高亮 + Mermaid + KaTeX 公式） */
function ChatMarkdown({ content, className = '', maxCite = 0 }: ChatMarkdownProps) {
  if (!content) return null
  const cited = (Tag: 'p' | 'li' | 'td' | 'th' | 'h1' | 'h2' | 'h3' | 'h4' | 'blockquote') =>
    function CitedEl({ children, ...props }: { children?: ReactNode }) {
      return createElement(Tag, props, mapCited(children, maxCite))
    }
  return (
    <div className={`chat-prose ${className}`}>
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        components={{
          p: cited('p'),
          li: cited('li'),
          td: cited('td'),
          th: cited('th'),
          h1: cited('h1'),
          h2: cited('h2'),
          h3: cited('h3'),
          h4: cited('h4'),
          blockquote: cited('blockquote'),
          pre({ children }) {
            // 由 code 组件自行包一层 pre，避免双重嵌套
            return <>{children}</>
          },
          code({ className: codeClass, children, ...props }) {
            const text = String(children).replace(/\n$/, '')
            // 数学分支必须最先判定：math-inline 也带 language-math，
            // 落到下面的 isBlock 分支会被误判为块级代码块
            const mathKind = classifyChatMath(codeClass)
            if (mathKind === 'inline') {
              return <MathInline tex={text} raw={'$' + text + '$'} />
            }
            if (mathKind === 'display') {
              return <MathBlock code={text} />
            }
            const match = /language-(\w+)/.exec(codeClass || '')
            const isBlock = Boolean(match) || text.includes('\n')
            if (!isBlock) {
              return (
                <code className={codeClass} {...props}>
                  {children}
                </code>
              )
            }
            const language = match?.[1] || ''
            if (language.toLowerCase() === 'mermaid') {
              return <MermaidDiagram code={text} className="my-3" />
            }
            return <ChatCodeBlock code={text} language={language} />
          },
          a({ href, children }) {
            const resolved = resolveMarkdownHref(href ?? '')
            if (resolved.kind === 'invalid') {
              return (
                <Tooltip label={i18next.t('block.invalidLink')}>
                  <span className="underline decoration-dotted decoration-muted-foreground/70 text-muted-foreground">
                    {children}
                  </span>
                </Tooltip>
              )
            }
            if (resolved.kind === 'hash') {
              return <a href={resolved.href}>{children}</a>
            }
            return (
              <a href={resolved.href} target="_blank" rel="noreferrer">
                {children}
              </a>
            )
          },
          table({ children }) {
            return (
              <div className="chat-prose-table-wrap">
                <table>{children}</table>
              </div>
            )
          },
          img({ node: _node, ...props }) {
            return <LightboxImg {...props} />
          },
        }}
      >
        {content}
      </Markdown>
    </div>
  )
}

function ChatCodeBlock({ code, language }: { code: string; language: string }) {
  const [html, setHtml] = useState<string | null>(null)
  const { t } = useTranslation()

  useEffect(() => {
    let cancelled = false
    if (!language) {
      setHtml(null)
      return
    }
    highlightCode(code, language).then((h) => {
      if (!cancelled) setHtml(h)
    })
    return () => {
      cancelled = true
    }
  }, [code, language])

  return (
    <div className="chat-code-block">
      <div className="chat-code-block-bar">
        <span className="chat-code-lang">{language || 'text'}</span>
        <CopyButton text={code} className="chat-code-copy" title={t('chat.copy')} iconClassName="w-3 h-3" />
      </div>
      <pre>
        {html
          ? createElement('code', {
              className: `hljs language-${language}`,
              dangerouslySetInnerHTML: { __html: html },
            })
          : createElement('code', null, code as ReactNode)}
      </pre>
    </div>
  )
}

export default memo(ChatMarkdown)
