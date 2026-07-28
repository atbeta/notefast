import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search,
  FileText,
  Plus,
  Moon,
  Sun,
  Hash,
  CornerDownLeft,
  ArrowUp,
  ArrowDown,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { SearchResult } from '@notefast/core'
import { request } from '../hooks/useAPI'
import { useTheme } from '../hooks/useTheme'
import { Kbd } from './ui'

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
}

type PaletteItem = {
  id: string
  icon: LucideIcon
  title: string
  hint?: string
  section: 'command' | 'document'
  shortcut?: string
  keywords?: string[]
  action: () => void
}

export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [active, setActive] = useState(0)
  const { resolvedTheme, setTheme } = useTheme()
  const dark = resolvedTheme === 'dark'
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => inputRef.current?.focus(), 30)
    setQuery('')
    setResults([])
    setActive(0)
    return () => clearTimeout(t)
  }, [open])

  // 当 query 变化时拉搜索结果
  useEffect(() => {
    if (!open) return
    if (query.trim().length < 2) {
      setResults([])
      setActive(0)
      return
    }
    setSearching(true)
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: query.trim(), limit: '8' })
      request<SearchResult[]>('/search?' + params.toString())
        .then((r) => {
          setResults(r)
          setActive(0)
        })
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    }, 120)
    return () => clearTimeout(timer)
  }, [query, open])

  const commands: PaletteItem[] = useMemo(() => {
    const toggleDark = () => {
      setTheme(dark ? 'light' : 'dark')
      onClose()
    }
    return [
      {
        id: 'cmd-new',
        icon: Plus,
        title: '新建文档',
        hint: '创建一个新的 Markdown 文档',
        section: 'command',
        shortcut: '⌘N',
        keywords: ['create', 'doc', 'new', '新建'],
        action: () => { onClose(); navigate('/new') },
      },
      {
        id: 'cmd-home',
        icon: Hash,
        title: '回到首页',
        hint: '所有文档列表',
        section: 'command',
        keywords: ['home', 'list', 'index', '首页'],
        action: () => { onClose(); navigate('/') },
      },
      {
        id: 'cmd-theme',
        icon: dark ? Sun : Moon,
        title: dark ? '切换到浅色' : '切换到深色',
        hint: '切换应用主题',
        section: 'command',
        shortcut: '⌘⇧D',
        keywords: ['theme', 'dark', 'light', '主题'],
        action: toggleDark,
      },
    ]
  }, [dark, navigate, onClose])

  const docItems: PaletteItem[] = useMemo(() => results.map((r) => ({
    id: 'doc-' + r.block.id,
    icon: FileText,
    title: r.block.root_id === r.block.id ? r.snippet.split('\n')[0]! : r.snippet.split('\n')[0]!,
    hint: r.snippet,
    section: 'document' as const,
    keywords: [r.snippet.toLowerCase()],
    action: () => { onClose(); navigate('/doc/' + r.block.root_id) },
  })), [results, navigate, onClose])

  const allItems: PaletteItem[] = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filteredCommands = q
      ? commands.filter((c) =>
          c.title.toLowerCase().includes(q) ||
          c.keywords?.some((k) => k.includes(q)))
      : commands
    return [...filteredCommands, ...docItems]
  }, [commands, docItems, query])

  // 键盘导航
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (allItems.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((a) => (a + 1) % allItems.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => (a - 1 + allItems.length) % allItems.length)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        allItems[active]?.action()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, active, allItems, onClose])

  // 滚动到 active 项
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-pal-index="${active}"]`)
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [active])

  const commandSection = allItems.filter((i) => i.section === 'command')
  const documentSection = allItems.filter((i) => i.section === 'document')

  return (
    <div
      aria-hidden={!open}
      className={`fixed inset-0 z-[100] flex items-start justify-center pt-[12vh] px-4 transition-opacity duration-[var(--dur)] ease-[var(--ease)] ${open ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      role="dialog"
      aria-modal="true"
      aria-label="命令面板"
    >
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className={`relative w-full max-w-xl bg-popover rounded-2xl border border-border shadow-2xl overflow-hidden transition-transform duration-[var(--dur)] ease-[var(--ease)] ${open ? 'translate-y-0 scale-100' : 'translate-y-2 scale-[0.98]'}`}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索文档、命令或文件…"
            className="flex-1 bg-transparent text-base text-foreground placeholder:text-muted-foreground outline-none"
          />
          <Kbd className="text-[11px]">esc</Kbd>
        </div>

        <div ref={listRef} className="max-h-[60vh] overflow-y-auto p-2">
          {allItems.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              {searching ? '搜索中…' : query ? '没有匹配的结果' : '试试搜索文档名或执行命令'}
            </div>
          )}

          {commandSection.length > 0 && (
            <SectionLabel>操作</SectionLabel>
          )}
          {commandSection.map((item) => {
            const index = allItems.indexOf(item)
            return (
              <PaletteRow
                key={item.id}
                item={item}
                index={index}
                active={index === active}
                onHover={() => setActive(index)}
                onClick={item.action}
              />
            )
          })}

          {documentSection.length > 0 && (
            <SectionLabel>{query ? '文档' : '最近文档'}</SectionLabel>
          )}
          {documentSection.map((item) => {
            const index = allItems.indexOf(item)
            return (
              <PaletteRow
                key={item.id}
                item={item}
                index={index}
                active={index === active}
                onHover={() => setActive(index)}
                onClick={item.action}
              />
            )
          })}
        </div>

        <div className="flex items-center justify-between gap-4 px-3 py-2 border-t border-border bg-secondary/40 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <ArrowUp className="w-3 h-3" />
              <ArrowDown className="w-3 h-3" />
              选择
            </span>
            <span className="inline-flex items-center gap-1">
              <CornerDownLeft className="w-3 h-3" />
              打开
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>esc</Kbd>
              关闭
            </span>
          </div>
          <span>⌘K</span>
        </div>
      </div>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-3 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  )
}

function PaletteRow({
  item,
  index,
  active,
  onHover,
  onClick,
}: {
  item: PaletteItem
  index: number
  active: boolean
  onHover: () => void
  onClick: () => void
}) {
  const Icon = item.icon
  return (
    <button
      type="button"
      data-pal-index={index}
      onMouseEnter={onHover}
      onClick={onClick}
      className={
        'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ' +
        (active
          ? 'bg-primary-soft text-foreground'
          : 'text-foreground/80 hover:bg-accent')
      }
    >
      <span
        className={
          'flex items-center justify-center w-8 h-8 rounded-md shrink-0 ' +
          (active ? 'bg-card text-primary' : 'bg-secondary text-muted-foreground')
        }
      >
        <Icon className="w-4 h-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{item.title}</div>
        {item.hint && (
          <div className="text-xs text-muted-foreground truncate mt-0.5">{item.hint}</div>
        )}
      </div>
      {item.shortcut && (
        <Kbd className="text-[11px] shrink-0">{item.shortcut}</Kbd>
      )}
    </button>
  )
}