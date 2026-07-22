import { useState, useEffect, createElement } from 'react'
import type { ReactNode } from 'react'
import { Copy, Check, Link2 } from 'lucide-react'
import type { Block } from '@notefast/core'
import { scrollToElement } from '../lib/scroll'
import { highlightCode } from '../lib/highlight'
import MermaidDiagram from './MermaidDiagram'

interface BlockNodeProps {
  block: Block
  depth?: number
}

interface BlockRendererProps {
  block: Block
  depth?: number
}

// ───────────────────────── 行内 Markdown 渲染 ─────────────────────────
// 支持：![image](url)、`code`、**bold**、*italic*、~~del~~、[text](url)、裸 URL
// 单一正则扫描，非嵌套场景覆盖绝大多数笔记内容；image 必须在 link 之前匹配

const INLINE_RE = /(!\[[^\]]*\]\([^)\s]+\))|(`[^`]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(~~[^~\n]+~~)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()"]+)/g

/** 裸 URL 尾部的标点不应吃进来（如「见 https://a.com/x, 」） */
function trimUrlTail(url: string): string {
  return url.replace(/[.,;:!?，。；：！？、\)）\]】'"]+$/, '')
}

function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  let k = 0
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0
    if (idx > last) nodes.push(text.slice(last, idx))
    if (m[1]) {
      const im = m[1].match(/!\[([^\]]*)\]\(([^)\s]+)\)/)!
      // asset:<id> 是 AssetStore 的稳定引用（见 server/assets/store.ts），渲染时解析为 API 路径
      const rawSrc = im[2]
      const src = rawSrc.startsWith('asset:') ? `/api/v1/assets/${rawSrc.slice(6)}` : rawSrc
      nodes.push(
        <img
          key={`${keyPrefix}-${k++}`}
          src={src}
          alt={im[1]}
          loading="lazy"
          className="my-3 max-w-full rounded-md border border-border/50"
        />,
      )
    } else if (m[2]) {
      nodes.push(<code key={`${keyPrefix}-${k++}`}>{m[2].slice(1, -1)}</code>)
    } else if (m[3]) {
      nodes.push(<strong key={`${keyPrefix}-${k++}`}>{renderInline(m[3].slice(2, -2), `${keyPrefix}s${k}`)}</strong>)
    } else if (m[4]) {
      nodes.push(<em key={`${keyPrefix}-${k++}`}>{m[4].slice(1, -1)}</em>)
    } else if (m[5]) {
      nodes.push(<del key={`${keyPrefix}-${k++}`} className="text-muted-foreground">{m[5].slice(2, -2)}</del>)
    } else if (m[6]) {
      const lm = m[6].match(/\[([^\]]+)\]\(([^)\s]+)\)/)!
      nodes.push(
        <a key={`${keyPrefix}-${k++}`} href={lm[2]} target="_blank" rel="noreferrer">
          {lm[1]}
        </a>,
      )
    } else if (m[7]) {
      const url = trimUrlTail(m[7])
      const tail = m[7].slice(url.length)
      nodes.push(
        <a key={`${keyPrefix}-${k++}`} href={url} target="_blank" rel="noreferrer">
          {url}
        </a>,
      )
      if (tail) nodes.push(tail)
    }
    last = idx + m[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

// ───────────────────────── Heading ─────────────────────────

function HeadingTag({ block }: { block: Block }) {
  // 兼容历史数据：新数据存 headingLevel，早期可能存 level
  const level =
    (block.properties.headingLevel as number) ||
    (block.properties.level as number) ||
    1
  const tagLevel = Math.min(Math.max(level, 1), 6) as 1 | 2 | 3 | 4 | 5 | 6
  const sizes: Record<number, string> = {
    1: 'text-[28px] mt-9 mb-3 font-bold',
    2: 'text-[24px] mt-7 mb-2.5 font-semibold',
    3: 'text-[20px] mt-6 mb-2 font-semibold',
    4: 'text-[16px] mt-5 mb-1.5 font-semibold',
    5: 'text-[14px] mt-4 mb-1 font-semibold',
    6: 'text-[13px] mt-4 mb-1 font-semibold text-muted-foreground',
  }
  return (
    <>
      {createElement(
        `h${tagLevel}`,
        {
          // id 使用 block.id：与大纲（HeadingNode.id = block.id）一致，支持点击定位
          id: block.id,
          className: `group relative ${sizes[tagLevel]} leading-[1.3] tracking-[-0.01em] text-foreground scroll-mt-20`,
        },
        <>
          <a
            href={`#${block.id}`}
            aria-label="定位到本节"
            className="absolute -left-6 top-1/2 -translate-y-1/2 p-1 rounded text-muted-foreground/70 opacity-0 group-hover:opacity-100 hover:text-foreground transition-all"
            onClick={(e) => {
              e.preventDefault()
              const el = document.getElementById(block.id)
              if (el) scrollToElement(el)
              history.replaceState(null, '', `#${block.id}`)
            }}
          >
            <Link2 className="w-3.5 h-3.5" strokeWidth={1.75} />
          </a>
          {renderInline(block.content || '', 'h')}
        </>,
      )}
      {/* 子块必须继续渲染：部分写入路径会把内容嵌在 heading 下（如代码块），不渲染就丢了 */}
      <ChildrenView children={block.children} />
    </>
  )
}

// ───────────────────────── Code ─────────────────────────

function CodeBlock({ block }: { block: Block }) {
  const lang = (block.properties.language as string) || ''
  if (lang.trim().toLowerCase() === 'mermaid') {
    return <MermaidDiagram code={block.content || ''} />
  }
  return <HighlightedCodeBlock block={block} lang={lang} />
}

function HighlightedCodeBlock({ block, lang }: { block: Block; lang: string }) {
  const [copied, setCopied] = useState(false)
  const [highlighted, setHighlighted] = useState<string | null>(null)

  // 语法高亮：异步懒加载 highlight.js；失败/未知语言回退纯文本
  useEffect(() => {
    let cancelled = false
    setHighlighted(null)
    if (lang && block.content) {
      highlightCode(block.content, lang)
        .then((html) => { if (!cancelled && html) setHighlighted(html) })
        .catch(() => {})
    }
    return () => { cancelled = true }
  }, [block.content, lang])

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
    <div className="my-5 rounded-lg border border-border bg-muted/30 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/60 border-b border-border">
        <span className="text-[11px] font-mono text-muted-foreground/80">
          {lang || 'text'}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded"
          aria-label={copied ? 'Copied' : 'Copy code'}
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5" strokeWidth={2} />
              <span>Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" strokeWidth={1.75} />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto text-[13px] font-mono leading-[1.6] text-foreground">
        {highlighted ? (
          <code
            className={`hljs language-${lang}`}
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        ) : (
          <code className={lang ? `language-${lang}` : ''}>{block.content}</code>
        )}
      </pre>
    </div>
  )
}

// ───────────────────────── Table ─────────────────────────

type Align = 'left' | 'center' | 'right'

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

function TableBlock({ block }: { block: Block }) {
  const rows = (block.content || '').split('\n').map((l) => l.trim()).filter(Boolean)
  if (rows.length < 2) {
    return <p className="text-muted-foreground">{block.content}</p>
  }
  const header = parseTableRow(rows[0])
  const aligns: Align[] = parseTableRow(rows[1]).map((c) =>
    c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left',
  )
  const body = rows.slice(2).map(parseTableRow)

  return (
    <div className="my-5 overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-[13.5px]">
        <thead>
          <tr className="bg-muted/50">
            {header.map((h, i) => (
              <th
                key={i}
                style={{ textAlign: aligns[i] || 'left' }}
                className="px-3 py-2 font-semibold text-foreground border-b border-border whitespace-nowrap"
              >
                {renderInline(h, `th${i}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri} className="hover:bg-muted/30 transition-colors">
              {r.map((c, ci) => (
                <td
                  key={ci}
                  style={{ textAlign: aligns[ci] || 'left' }}
                  className="px-3 py-2 border-b border-border/50 text-foreground/90"
                >
                  {renderInline(c, `td${ri}-${ci}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ───────────────────────── 列表（ul/ol + 任务列表）─────────────────────────
// 持久化树里没有 List 包装节点（解析期被拍平），渲染时把连续的同级 list_item
// 重新归并成组：ordered 标记一致的连续段为一组。

function ListItemView({ block }: { block: Block }) {
  const isTask = Boolean(block.properties.task)
  const checked = Boolean(block.properties.checked)
  const nestedItems = block.children.filter((c) => c.type === 'list_item')
  const otherChildren = block.children.filter((c) => c.type !== 'list_item')
  return (
    <li className="leading-[1.75] text-foreground/95">
      {isTask && (
        <span
          className={`mr-2 inline-flex h-3.5 w-3.5 translate-y-[2px] items-center justify-center rounded-[3px] border transition-colors ${
            checked
              ? 'border-foreground bg-foreground text-background'
              : 'border-border-strong/60 bg-transparent'
          }`}
        >
          {checked && <Check className="w-2.5 h-2.5" strokeWidth={3} />}
        </span>
      )}
      <span className={isTask && checked ? 'line-through text-muted-foreground' : undefined}>
        {renderInline(block.content || '', `li-${block.id}`)}
      </span>
      {otherChildren.map((child) => (
        <BlockNode key={child.id} block={child} />
      ))}
      {nestedItems.length > 0 && (
        <ListGroup items={nestedItems} className="pl-5 mt-1.5" />
      )}
    </li>
  )
}

function ListGroup({ items, className }: { items: Block[]; className?: string }) {
  const ordered = Boolean(items[0]?.properties.ordered)
  const Tag = ordered ? 'ol' : 'ul'
  return (
    <Tag
      className={`${ordered ? 'list-decimal' : 'list-disc'} pl-6 marker:text-muted-foreground/70 space-y-1.5 ${className ?? 'my-3'}`}
    >
      {items.map((item) => (
        <ListItemView key={item.id} block={item} />
      ))}
    </Tag>
  )
}

type ChildGroup =
  | { kind: 'list'; key: string; ordered: boolean; items: Block[] }
  | { kind: 'single'; key: string; block: Block }

function ChildrenView({ children }: { children: Block[] }) {
  const groups: ChildGroup[] = []
  for (const child of children) {
    if (child.type === 'list_item') {
      const ordered = Boolean(child.properties.ordered)
      const last = groups[groups.length - 1]
      if (last && last.kind === 'list' && last.ordered === ordered) {
        last.items.push(child)
      } else {
        groups.push({ kind: 'list', key: child.id, ordered, items: [child] })
      }
    } else {
      groups.push({ kind: 'single', key: child.id, block: child })
    }
  }
  return (
    <>
      {groups.map((g) =>
        g.kind === 'list' ? (
          <ListGroup key={g.key} items={g.items} />
        ) : (
          <BlockNode key={g.key} block={g.block} />
        ),
      )}
    </>
  )
}

// ───────────────────────── 树遍历 ─────────────────────────

function BlockNode({ block }: BlockNodeProps) {
  switch (block.type) {
    case 'heading':
      return <HeadingTag block={block} />

    case 'paragraph':
      // 水平分隔线（---）渲染为 hr，而非字面文本
      if (block.content && /^-{3,}\s*$/.test(block.content.trim())) {
        return <hr className="my-7 border-border/70" />
      }
      return (
        <p className="leading-[1.75] text-foreground/95">
          {block.content ? renderInline(block.content, `p-${block.id}`) : <span className="text-muted-foreground">（空白段落）</span>}
        </p>
      )

    case 'list':
      return <ListGroup items={block.children} />

    case 'list_item':
      return <ListGroup items={[block]} />

    case 'code':
      return <CodeBlock block={block} />

    case 'table':
      return <TableBlock block={block} />

    case 'quote':
      return (
        <blockquote className="my-5 pl-4 border-l-[3px] border-foreground/80 text-foreground">
          <p className="leading-[1.65] text-[1.05em]">{renderInline(block.content || '', `q-${block.id}`)}</p>
          <ChildrenView children={block.children} />
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
        <ChildrenView children={block.children} />
      </article>
    )
  }

  return (
    <div className="reading-prose">
      <BlockNode block={block} depth={depth} />
    </div>
  )
}
