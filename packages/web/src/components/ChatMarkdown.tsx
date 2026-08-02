import { useState, useEffect, createElement, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { highlightCode } from '../lib/highlight'
import MermaidDiagram from './MermaidDiagram'
import { CopyButton } from './ui'
import { useTranslation } from 'react-i18next'

interface ChatMarkdownProps {
  content: string
  className?: string
}

/** 聊天气泡内的 Markdown 渲染（GFM + 代码高亮 + Mermaid） */
export default function ChatMarkdown({ content, className = '' }: ChatMarkdownProps) {
  if (!content) return null
  return (
    <div className={`chat-prose ${className}`}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            // 由 code 组件自行包一层 pre，避免双重嵌套
            return <>{children}</>
          },
          code({ className: codeClass, children, ...props }) {
            const text = String(children).replace(/\n$/, '')
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
            return (
              <a href={href} target="_blank" rel="noreferrer">
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
