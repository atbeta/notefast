import { useState, createElement } from 'react'
import { Copy, Check } from 'lucide-react'
import type { Block } from '@notefast/core'

interface BlockNodeProps {
  block: Block
  depth?: number
}

interface BlockRendererProps {
  block: Block
  depth?: number
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

function HeadingTag({ block, depth: _depth }: { block: Block; depth: number }) {
  const level = (block.properties.level as number) || 1
  const tagLevel = Math.min(level + 1, 6) as 2 | 3 | 4 | 5 | 6
  const id = slugify(block.content || '')
  // 字号 + 节奏参考 Notion：h2 最大但 line-height 紧；h2 与正文之间间距大，
  // 同行标题（h4/h5）之间间距小，体现层次而非"单位化的等距堆叠"。
  const sizes: Record<number, string> = {
    2: 'text-[26px] mt-10 mb-3 leading-[1.18] tracking-[-0.025em] font-semibold text-foreground',
    3: 'text-[20px] mt-8 mb-2 leading-[1.25] tracking-[-0.02em] font-semibold text-foreground',
    4: 'text-[16px] mt-6 mb-1.5 leading-[1.35] tracking-[-0.015em] font-semibold text-foreground/95',
    5: 'text-[14.5px] mt-5 mb-1 leading-[1.4] font-semibold text-foreground/90',
    6: 'text-[12.5px] mt-5 mb-1 text-muted-foreground uppercase tracking-[0.08em] font-medium',
  }
  const tag = `h${tagLevel}`
  return createElement(
    tag,
    { id, className: sizes[tagLevel] },
    <a href={`#${id}`} className="no-underline text-inherit hover:text-foreground">
      {block.content}
    </a>,
  )
}

function CodeBlock({ block }: { block: Block }) {
  const lang = (block.properties.language as string) || ''
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(block.content || '')
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="my-5 rounded-lg overflow-hidden border border-border bg-card shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between px-3.5 py-1.5 bg-muted/60 border-b border-border">
        <span className="text-[11px] font-mono uppercase tracking-[0.04em] text-muted-foreground">
          {lang || 'code'}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded"
          aria-label={copied ? 'Copied' : 'Copy code'}
        >
          {copied ? (
            <>
              <Check className="w-3 h-3" strokeWidth={2} />
              <span>Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" strokeWidth={1.75} />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto text-[13px] font-mono leading-[1.6] text-foreground/90">
        <code className={lang ? `language-${lang}` : ''}>{block.content}</code>
      </pre>
    </div>
  )
}

function BlockNode({ block, depth = 0 }: BlockNodeProps) {
  switch (block.type) {
    case 'heading':
      return (
        <HeadingTag block={block} depth={depth} />
      )

    case 'paragraph':
      return (
        <p className="leading-[1.72] text-foreground/95">
          {block.content || <span className="text-muted-foreground">（空白段落）</span>}
        </p>
      )

    case 'list':
      return (
        <ul className="list-disc pl-6 marker:text-muted-foreground/70 space-y-1.5">
          {block.children.map((child) => (
            <BlockNode key={child.id} block={child} depth={depth + 1} />
          ))}
        </ul>
      )

    case 'list_item':
      return (
        <li className="leading-[1.72] text-foreground/95">
          <span>{block.content}</span>
          {block.children.length > 0 && (
            <ul className="list-disc pl-5 mt-1.5 marker:text-muted-foreground/70">
              {block.children.map((child) => (
                <BlockNode key={child.id} block={child} depth={depth + 1} />
              ))}
            </ul>
          )}
        </li>
      )

    case 'code':
      return <CodeBlock block={block} />

    case 'quote':
      return (
        <blockquote className="my-5 pl-4 border-l-2 border-primary/45 text-muted-foreground italic">
          <p className="leading-[1.72] not-italic">{block.content}</p>
          {block.children.map((child) => (
            <BlockNode key={child.id} block={child} depth={depth + 1} />
          ))}
        </blockquote>
      )

    default:
      return <p className="text-muted-foreground italic">[未识别块类型：{block.type}]</p>
  }
}

export default function BlockRenderer({ block, depth = 0 }: BlockRendererProps) {
  if (!block) {
    return <p className="text-muted-foreground italic">空白文档</p>
  }

  if (depth > 20) return null

  if (block.type === 'document') {
    return (
      <article className="reading-prose">
        {block.children.map((child) => (
          <BlockNode key={child.id} block={child} depth={depth + 1} />
        ))}
      </article>
    )
  }

  return (
    <div className="reading-prose">
      <BlockNode block={block} depth={depth} />
    </div>
  )
}
