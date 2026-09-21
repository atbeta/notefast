/**
 * 文档阅读态文内查找条。⌘F 打开（macOS 壳经菜单派发 nf:find，因 WKWebView 默认不处理查找）。
 * 高亮走 CSS Custom Highlight（不插 DOM 节点，所以查找不会弄脏文档状态）；
 * 不支持时只滚动到命中。
 *
 * 匹配一律走 lib/docFind.ts 的 compileFind（唯一实现），这里只负责：
 * 把「上屏文本 → 偏移 → Range → 高亮」串起来，以及三个开关的 UI。
 * 正文变化（SSE 推送、mermaid 异步落笔、折叠目录展开）会让旧命中集合失效，
 * 所以开着查找条时挂一个 MutationObserver 重算——否则计数显示的是「上一版正文」的数字。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import {
  DEFAULT_FIND_OPTIONS,
  DOC_FIND_EVENT,
  DOC_FIND_NEXT_EVENT,
  DOC_FIND_PREV_EVENT,
  compileFind,
  stepFindIndex,
  type FindError,
  type FindOptions,
  type FindRange,
} from '../lib/docFind'

const HIGHLIGHT_ALL = 'nf-find'
const HIGHLIGHT_CUR = 'nf-find-current'

/** 正文变化后重算命中的防抖（mermaid 落笔会连着改好几次 DOM）。 */
const RECOMPUTE_DEBOUNCE_MS = 150

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

/** 查找开关按钮：三个共用一套样式与语义（aria-pressed + title）。 */
function FindToggle({
  label,
  pressed,
  onToggle,
  children,
}: {
  label: string
  pressed: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center h-6 min-w-6 px-1 rounded-md font-mono text-xs transition-colors ${
        pressed
          ? 'text-primary bg-primary/12 hover:bg-primary/15'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent'
      }`}
    >
      {children}
    </button>
  )
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
  const [opts, setOpts] = useState<FindOptions>(DEFAULT_FIND_OPTIONS)
  const [error, setError] = useState<FindError | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const rangesRef = useRef<Range[]>([])
  // MutationObserver 的回调要读「最新的查询与开关」，但不该因为敲字重建 observer
  const queryRef = useRef(query)
  const optsRef = useRef(opts)
  queryRef.current = query
  optsRef.current = opts

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    setCurrent(-1)
    setCount(0)
    setError(null)
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
    (q: string, options: FindOptions) => {
      // 编译一次，计数与高亮共用同一批命中（见 lib/docFind.ts 头注释）
      const compiled = compileFind(q, options)
      const root = resolveRoot(rootRef)
      if (!compiled.ok) {
        // 'empty'（还没输入）不算错误，只是没有结果；正则问题要明说，
        // 静默当 0 处会让人以为「文档里没有」。
        setError(compiled.error === 'empty' ? null : compiled.error)
        rangesRef.current = []
        setCount(0)
        setCurrent(-1)
        clearHighlights()
        return
      }
      setError(null)
      if (!root) {
        rangesRef.current = []
        setCount(0)
        setCurrent(-1)
        clearHighlights()
        return
      }
      const matches = compiled.find(collectText(root))
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
    const frame = requestAnimationFrame(() => runQuery(query, opts))
    return () => cancelAnimationFrame(frame)
    // opts 是三布尔对象：逐项列出依赖，避免每次渲染都重跑（对象字面量每次都新）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, opts.caseSensitive, opts.wholeWord, opts.regex, open, rootRef, runQuery, docId])

  /**
   * 正文变化后重算命中：SSE 推送换内容、mermaid/KaTeX 异步落笔、折叠目录展开
   * 都会让旧偏移失效。高亮走 CSS Custom Highlight、不改 DOM，所以这里不会自触发。
   */
  useEffect(() => {
    if (!open) return
    const root = resolveRoot(rootRef)
    if (!root || typeof MutationObserver === 'undefined') return
    let timer = 0
    const observer = new MutationObserver(() => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = 0
        runQuery(queryRef.current, optsRef.current)
      }, RECOMPUTE_DEBOUNCE_MS)
    })
    observer.observe(root, { childList: true, characterData: true, subtree: true })
    return () => {
      if (timer) window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [open, rootRef, runQuery, docId])

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
          data-no-focus-ring
          className="w-40 bg-transparent text-base text-foreground placeholder:text-muted-foreground/60 outline-none px-1"
          aria-label={t('doc.findPlaceholder')}
        />
        <span className="text-xs tabular-nums text-muted-foreground min-w-[2.75rem] text-right">
          {error
            ? t(error === 'invalid-regex' ? 'doc.findInvalidRegex' : 'doc.findRiskyRegex')
            : query.trim()
              ? count === 0
                ? t('doc.findNone')
                : t('doc.findCount', { n: current + 1, total: count })
              : ''}
        </span>
        {/* 三个开关用 Aa / \b / .* 这组符号而不是文字：查找界面里跨语言通用
            （VS Code、浏览器都是这套），含义交给 title 与 aria-label。 */}
        <FindToggle
          label={t('doc.findCase')}
          pressed={opts.caseSensitive}
          onToggle={() => setOpts((o) => ({ ...o, caseSensitive: !o.caseSensitive }))}
        >
          Aa
        </FindToggle>
        <FindToggle
          label={t('doc.findWhole')}
          pressed={opts.wholeWord}
          onToggle={() => setOpts((o) => ({ ...o, wholeWord: !o.wholeWord }))}
        >
          {'\\b'}
        </FindToggle>
        <FindToggle
          label={t('doc.findRegex')}
          pressed={opts.regex}
          onToggle={() => setOpts((o) => ({ ...o, regex: !o.regex }))}
        >
          .*
        </FindToggle>
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
