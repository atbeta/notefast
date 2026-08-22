/**
 * 文档阅读态文内查找条。⌘F 打开（macOS 壳经菜单派发 nf:find，因 WKWebView 默认不处理查找）。
 * 高亮走 CSS Custom Highlight；不支持时只滚动到命中。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import {
  DOC_FIND_EVENT,
  DOC_FIND_NEXT_EVENT,
  DOC_FIND_PREV_EVENT,
  findMatchRanges,
  stepFindIndex,
  type FindRange,
} from '../lib/docFind'

const HIGHLIGHT_ALL = 'nf-find'
const HIGHLIGHT_CUR = 'nf-find-current'

function resolveRoot(ref: React.RefObject<HTMLElement | null>): HTMLElement | null {
  return ref.current ?? document.querySelector<HTMLElement>('.cm-content, article.reading-prose, .reading-prose')
}

function collectText(root: Node): string {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let s = ''
  let n: Node | null
  while ((n = w.nextNode())) s += (n as Text).data
  return s
}

function rangesFromOffsets(root: Node, matches: FindRange[]): Range[] {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const pieces: { node: Text; start: number; end: number }[] = []
  let offset = 0
  let n: Node | null
  while ((n = w.nextNode())) {
    const node = n as Text
    const len = node.data.length
    pieces.push({ node, start: offset, end: offset + len })
    offset += len
  }
  const out: Range[] = []
  for (const m of matches) {
    const r = document.createRange()
    let started = false
    for (const p of pieces) {
      if (!started && m.start >= p.start && m.start <= p.end) {
        r.setStart(p.node, Math.min(m.start - p.start, p.node.data.length))
        started = true
      }
      if (started && m.end >= p.start && m.end <= p.end) {
        r.setEnd(p.node, Math.min(m.end - p.start, p.node.data.length))
        out.push(r)
        break
      }
    }
  }
  return out
}

function cssHighlights(): { set: (k: string, v: Highlight) => void; delete: (k: string) => void } | null {
  const map = (CSS as unknown as { highlights?: { set: (k: string, v: Highlight) => void; delete: (k: string) => void } }).highlights
  return map ?? null
}

function applyHighlights(ranges: Range[], current: number): void {
  const map = cssHighlights()
  if (!map || typeof Highlight === 'undefined') return
  const rest = ranges.filter((_, i) => i !== current)
  if (rest.length > 0) map.set(HIGHLIGHT_ALL, new Highlight(...rest))
  else map.delete(HIGHLIGHT_ALL)
  const cur = current >= 0 ? ranges[current] : undefined
  if (cur) map.set(HIGHLIGHT_CUR, new Highlight(cur))
  else map.delete(HIGHLIGHT_CUR)
}

function clearHighlights(): void {
  const map = cssHighlights()
  if (!map) return
  map.delete(HIGHLIGHT_ALL)
  map.delete(HIGHLIGHT_CUR)
}

function isFindPassthrough(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('[data-doc-find]')) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.getAttribute('contenteditable') === 'true') return true
  return false
}

export default function DocFindBar({
  rootRef,
  disabled,
  docId,
}: {
  rootRef: React.RefObject<HTMLElement | null>
  disabled?: boolean
  /** 换篇后按新正文重搜 */
  docId?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [current, setCurrent] = useState(-1)
  const [count, setCount] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const rangesRef = useRef<Range[]>([])

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    setCurrent(-1)
    setCount(0)
    rangesRef.current = []
    clearHighlights()
  }, [])

  const reveal = useCallback((idx: number, ranges: Range[]) => {
    const r = ranges[idx]
    if (!r) return
    const node = r.startContainer instanceof Element ? r.startContainer : r.startContainer.parentElement
    node?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [])

  const runQuery = useCallback(
    (q: string) => {
      const root = resolveRoot(rootRef)
      if (!root) {
        rangesRef.current = []
        setCount(0)
        setCurrent(-1)
        clearHighlights()
        return
      }
      const matches = findMatchRanges(collectText(root), q)
      const ranges = rangesFromOffsets(root, matches)
      rangesRef.current = ranges
      setCount(ranges.length)
      if (ranges.length === 0) {
        setCurrent(-1)
        clearHighlights()
        return
      }
      setCurrent(0)
      applyHighlights(ranges, 0)
      reveal(0, ranges)
    },
    [rootRef, reveal],
  )

  const openBar = useCallback(() => {
    if (disabled) return
    setOpen(true)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [disabled])

  const step = useCallback(
    (dir: 1 | -1) => {
      const ranges = rangesRef.current
      if (ranges.length === 0) return
      const idx = stepFindIndex(current, ranges.length, dir)
      setCurrent(idx)
      applyHighlights(ranges, idx)
      reveal(idx, ranges)
    },
    [current, reveal],
  )

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => runQuery(query))
    return () => cancelAnimationFrame(frame)
  }, [query, open, rootRef, runQuery, docId])

  useEffect(() => () => clearHighlights(), [])

  useEffect(() => {
    if (disabled && open) close()
  }, [disabled, open, close])

  useEffect(() => {
    const onFind = () => openBar()
    const onNext = () => {
      if (!open) openBar()
      else step(1)
    }
    const onPrev = () => {
      if (!open) openBar()
      else step(-1)
    }
    window.addEventListener(DOC_FIND_EVENT, onFind)
    window.addEventListener(DOC_FIND_NEXT_EVENT, onNext)
    window.addEventListener(DOC_FIND_PREV_EVENT, onPrev)
    return () => {
      window.removeEventListener(DOC_FIND_EVENT, onFind)
      window.removeEventListener(DOC_FIND_NEXT_EVENT, onNext)
      window.removeEventListener(DOC_FIND_PREV_EVENT, onPrev)
    }
  }, [open, openBar, step])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (mod && key === 'f') {
        if (isFindPassthrough(e.target)) return
        if (disabled) return
        e.preventDefault()
        openBar()
        return
      }
      if (!open) return
      if (key === 'escape') {
        e.preventDefault()
        close()
        return
      }
      if ((mod && key === 'g' && e.shiftKey) || (key === 'f3' && e.shiftKey)) {
        e.preventDefault()
        step(-1)
        return
      }
      if ((mod && key === 'g') || key === 'f3') {
        e.preventDefault()
        step(1)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, disabled, openBar, close, step])

  if (!open) return null

  return (
    <div
      data-doc-find
      data-print="hide"
      className="sticky top-2 z-dropdown mb-3 flex justify-end print:hidden"
    >
      <div className="flex items-center gap-1 rounded-md border border-border bg-card px-1.5 py-1 shadow-floating">
        <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0 ml-0.5" strokeWidth={1.75} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              step(e.shiftKey ? -1 : 1)
            }
          }}
          placeholder={t('doc.findPlaceholder')}
          className="w-40 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/60 outline-none px-1"
          aria-label={t('doc.findPlaceholder')}
        />
        <span className="text-[11px] tabular-nums text-muted-foreground min-w-[2.75rem] text-right">
          {query.trim() ? (count === 0 ? t('doc.findNone') : t('doc.findCount', { n: current + 1, total: count })) : ''}
        </span>
        <button
          type="button"
          onClick={() => step(-1)}
          disabled={count === 0}
          className="btn-icon-ghost text-muted-foreground hover:text-foreground disabled:opacity-30"
          aria-label={t('doc.findPrev')}
        >
          <ChevronUp className="w-3.5 h-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={() => step(1)}
          disabled={count === 0}
          className="btn-icon-ghost text-muted-foreground hover:text-foreground disabled:opacity-30"
          aria-label={t('doc.findNext')}
        >
          <ChevronDown className="w-3.5 h-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={close}
          className="btn-icon-ghost text-muted-foreground hover:text-foreground"
          aria-label={t('doc.findClose')}
        >
          <X className="w-3.5 h-3.5" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  )
}
