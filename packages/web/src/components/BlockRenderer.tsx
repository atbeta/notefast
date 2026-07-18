import { useState, createElement } from 'react'
import { Copy, Check, Sparkles, Wand2, ArrowRightLeft, AlignLeft, Loader2 } from 'lucide-react'
import type { Block } from '@notefast/core'
import { request } from '../hooks/useAPI'

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

function AIHoverMenu({ block, onRewrite }: { block: Block, onRewrite: (newContent: string) => void }) {
  const [isOpen, setIsOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleAction = async (prompt: string) => {
    if (loading) return
    setLoading(true)
    setIsOpen(false)
    try {
      // 借用 suggest-title 接口进行内容重写，实际项目中应该增加专门的 block-rewrite 接口
      const res = await request<{ summary: string }>('/ai/suggest-title', {
        method: 'POST',
        body: JSON.stringify({ content: `请执行以下操作：${prompt}\n\n[原始内容]\n${block.content}` }),
      })
      if (res.summary) {
        onRewrite(res.summary)
      }
    } catch (err) {
      console.error('AI action failed:', err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div 
      className="absolute -left-10 top-1/2 -translate-y-1/2 opacity-0 group-hover/block:opacity-100 transition-opacity z-10"
      onMouseLeave={() => setIsOpen(false)}
    >
      <div className="relative">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="p-1.5 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
          title="AI 助手"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin text-primary" /> : <Sparkles className="w-4 h-4" />}
        </button>

        {isOpen && (
          <div className="absolute left-0 top-full mt-1 w-40 bg-popover border border-border rounded-lg shadow-lg py-1 flex flex-col z-20 animate-fade-in">
            <button 
              onClick={() => handleAction('帮我润色并改进这段文本的表达')}
              className="flex items-center gap-2 px-3 py-1.5 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground text-left"
            >
              <Wand2 className="w-3.5 h-3.5" /> 润色文本
            </button>
            <button 
              onClick={() => handleAction('将这段文本改写得更专业、正式')}
              className="flex items-center gap-2 px-3 py-1.5 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground text-left"
            >
              <ArrowRightLeft className="w-3.5 h-3.5" /> 专业语气
            </button>
            <button 
              onClick={() => handleAction('帮我把这段文本总结得更简短精炼')}
              className="flex items-center gap-2 px-3 py-1.5 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground text-left"
            >
              <AlignLeft className="w-3.5 h-3.5" /> 缩写总结
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function HeadingTag({ block }: { block: Block; depth: number }) {
  const level = (block.properties.level as number) || 1
  const tagLevel = Math.min(level + 1, 6) as 2 | 3 | 4 | 5 | 6
  const id = slugify(block.content || '')
  const sizes: Record<number, string> = {
    2: 'text-2xl font-bold mt-7 mb-3 text-foreground',
    3: 'text-xl font-semibold mt-6 mb-2 text-foreground',
    4: 'text-lg font-semibold mt-5 mb-2 text-foreground/90',
    5: 'text-base font-semibold mt-4 mb-2 text-foreground/90',
    6: 'text-sm font-semibold mt-3 mb-2 text-muted-foreground uppercase tracking-wide',
  }
  const className = `${sizes[tagLevel]} scroll-mt-20 hover:text-primary transition-colors inline-block`
  const tag = `h${tagLevel}`
  return createElement(
    tag,
    { id, className },
    <a href={`#${id}`} className="no-underline text-inherit">{block.content}</a>,
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
    <div className="relative my-4 rounded-xl overflow-hidden border border-border bg-secondary shadow-sm">
      <div className="flex items-center justify-between px-4 py-1.5 bg-muted border-b border-border">
        <span className="text-xs font-mono text-muted-foreground uppercase tracking-wide">
          {lang || 'code'}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors px-2 py-1 rounded-md hover:bg-accent"
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
      <pre className="p-4 overflow-x-auto text-sm font-mono leading-relaxed text-foreground">
        <code className={lang ? `language-${lang}` : ''}>{block.content}</code>
      </pre>
    </div>
  )
}

function BlockNode({ block, depth = 0 }: BlockNodeProps) {
  // 临时状态，用于前端直接展示 AI 重写后的结果（刷新后会丢失，因为没有调用 update block API）
  const [optimisticContent, setOptimisticContent] = useState<string | null>(null)
  
  const displayContent = optimisticContent !== null ? optimisticContent : block.content
  const renderBlock = { ...block, content: displayContent }

  switch (block.type) {
    case 'heading':
      return (
        <div className="relative group/block pl-2">
          <AIHoverMenu block={renderBlock} onRewrite={setOptimisticContent} />
          <HeadingTag block={renderBlock} depth={depth} />
          {block.children.map((child) => (
            <BlockNode key={child.id} block={child} depth={depth + 1} />
          ))}
        </div>
      )

    case 'paragraph':
      return (
        <div className="relative group/block pl-2">
          <AIHoverMenu block={renderBlock} onRewrite={setOptimisticContent} />
          <p className="text-foreground/90 leading-relaxed my-3">{displayContent}</p>
        </div>
      )

    case 'list':
      return (
        <ul className="list-disc list-inside my-3 text-foreground/90 space-y-1 pl-2">
          {block.children.map((child) => (
            <BlockNode key={child.id} block={child} depth={depth + 1} />
          ))}
        </ul>
      )

    case 'list_item':
      return (
        <li className="leading-relaxed relative group/block">
          <AIHoverMenu block={renderBlock} onRewrite={setOptimisticContent} />
          <span>{displayContent}</span>
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
      return (
        <div className="relative group/block pl-2">
          <AIHoverMenu block={renderBlock} onRewrite={setOptimisticContent} />
          <CodeBlock block={renderBlock} />
        </div>
      )

    case 'quote':
      return (
        <div className="relative group/block pl-2">
          <AIHoverMenu block={renderBlock} onRewrite={setOptimisticContent} />
          <blockquote className="border-l-4 border-primary/70 bg-secondary pl-4 pr-3 py-2 my-4 italic text-foreground/85 rounded-r-lg">
            <p>{displayContent}</p>
            {block.children.map((child) => (
              <BlockNode key={child.id} block={child} depth={depth + 1} />
            ))}
          </blockquote>
        </div>
      )

    default:
      return <p className="text-muted-foreground italic">[Unknown block type: {block.type}]</p>
  }
}

export default function BlockRenderer({ block, depth = 0 }: BlockRendererProps) {
  if (!block) {
    return <p className="text-muted-foreground italic">Empty document</p>
  }

  if (depth > 20) return null

  if (block.type === 'document') {
    return (
      <article className="prose dark:prose-invert max-w-none ml-8">
        {block.children.map((child) => (
          <BlockNode key={child.id} block={child} depth={depth + 1} />
        ))}
      </article>
    )
  }

  return (
    <div className="prose dark:prose-invert max-w-none ml-8">
      <BlockNode block={block} depth={depth} />
    </div>
  )
}
