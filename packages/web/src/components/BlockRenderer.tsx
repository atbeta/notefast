import { useState } from 'react'
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

function HeadingTag({ block }: { block: Block; depth: number }) {
  const level = (block.properties.level as number) || 1
  const tagLevel = Math.min(level + 1, 6) as 2 | 3 | 4 | 5 | 6
  const id = slugify(block.content || '')
  const sizes: Record<number, string> = {
    2: 'text-2xl font-bold mt-7 mb-3 text-warm-800 dark:text-warm-100',
    3: 'text-xl font-semibold mt-6 mb-2 text-warm-800 dark:text-warm-100',
    4: 'text-lg font-semibold mt-5 mb-2 text-warm-700 dark:text-warm-200',
    5: 'text-base font-semibold mt-4 mb-2 text-warm-700 dark:text-warm-200',
    6: 'text-sm font-semibold mt-3 mb-2 text-warm-600 dark:text-warm-300 uppercase tracking-wide',
  }
  const className = `${sizes[tagLevel]} scroll-mt-20 hover:text-brand-600 dark:hover:text-brand-400 transition-colors`
  const Tag = `h${tagLevel}` as keyof JSX.IntrinsicElements
  return (
    <Tag id={id} className={className}>
      <a href={`#${id}`} className="no-underline text-inherit">{block.content}</a>
    </Tag>
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
      // fallback: do nothing
    }
  }

  return (
    <div className="relative my-4 rounded-xl overflow-hidden border border-warm-200 dark:border-warm-700 bg-warm-50 dark:bg-warm-900 shadow-sm">
      <div className="flex items-center justify-between px-4 py-1.5 bg-warm-100 dark:bg-warm-800 border-b border-warm-200 dark:border-warm-700">
        <span className="text-xs font-mono text-warm-600 dark:text-warm-400 uppercase tracking-wide">
          {lang || 'code'}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 text-xs text-warm-600 dark:text-warm-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors px-2 py-1 rounded-md hover:bg-warm-200 dark:hover:bg-warm-700"
          aria-label={copied ? 'Copied' : 'Copy code'}
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5" />
              <span>Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto text-sm font-mono leading-relaxed text-warm-900 dark:text-warm-100">
        <code className={lang ? `language-${lang}` : ''}>{block.content}</code>
      </pre>
    </div>
  )
}

function BlockNode({ block, depth = 0 }: BlockNodeProps) {
  switch (block.type) {
    case 'heading':
      return (
        <div>
          <HeadingTag block={block} depth={depth} />
          {block.children.map((child) => (
            <BlockNode key={child.id} block={child} depth={depth + 1} />
          ))}
        </div>
      )

    case 'paragraph':
      return <p className="text-warm-800 dark:text-warm-200 leading-relaxed my-3">{block.content}</p>

    case 'list':
      return (
        <ul className="list-disc list-inside my-3 text-warm-800 dark:text-warm-200 space-y-1">
          {block.children.map((child) => (
            <BlockNode key={child.id} block={child} depth={depth + 1} />
          ))}
        </ul>
      )

    case 'list_item':
      return (
        <li className="leading-relaxed">
          {block.content}
          {block.children.length > 0 && (
            <ul className="list-disc list-inside mt-1 ml-4 space-y-1">
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
        <blockquote className="border-l-4 border-brand-400 dark:border-brand-600 bg-warm-50 dark:bg-warm-900 pl-4 pr-3 py-2 my-4 italic text-warm-700 dark:text-warm-300 rounded-r-lg">
          <p>{block.content}</p>
          {block.children.map((child) => (
            <BlockNode key={child.id} block={child} depth={depth + 1} />
          ))}
        </blockquote>
      )

    default:
      return <p className="text-warm-400 italic">[Unknown block type: {block.type}]</p>
  }
}

export default function BlockRenderer({ block, depth = 0 }: BlockRendererProps) {
  if (!block) {
    return <p className="text-warm-400 dark:text-warm-500 italic">Empty document</p>
  }

  // Safety net against runway recursion
  if (depth > 20) return null

  // Top-level: render article with optional title (h1) from document content
  if (block.type === 'document') {
    return (
      <article className="prose prose-warm dark:prose-invert max-w-none">
        {block.content && depth === 0 && (
          <h1 className="text-3xl font-bold mb-8 text-warm-900 dark:text-warm-50">{block.content}</h1>
        )}
        {block.children.map((child) => (
          <BlockNode key={child.id} block={child} depth={depth + 1} />
        ))}
      </article>
    )
  }

  return (
    <div className="prose prose-warm dark:prose-invert max-w-none">
      <BlockNode block={block} depth={depth} />
    </div>
  )
}
