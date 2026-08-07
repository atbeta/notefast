import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { isNativeShell } from '../lib/nativeShell'
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
import { Kbd, ShortcutKeys } from './ui'

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
  shortcut?: string[]
  keywords?: string[]
  action: () => void
}

export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [active, setActive] = useState(0)
  const { resolvedTheme, setTheme } = useTheme()
  const dark = resolvedTheme === 'dark'
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const maskRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => inputRef.current?.focus(), 30)
    setQuery('')
    setResults([])
    setActive(0)
    return () => clearTimeout(t)
  }, [open])

  // 遮罩虚化：CSS transition 的 backdrop-filter 在 WKWebView/Safari 不按帧插值（跳变），
  // 造成「先糊满、黑色才淡入」的二段式。改用 rAF 逐帧写 blur(0↔4px)，与遮罩 opacity
  // 过渡（150ms, var(--ease)）同步——任何引擎都按帧生效。
  useEffect(() => {
    const el = maskRef.current
    if (!el) return
    let raf = 0
    const start = performance.now()
    const DUR = 150
    // 近似 var(--ease) cubic-bezier(0.2,0,0,1) 的缓出曲线
    const ease = (p: number) => 1 - Math.pow(1 - p, 3)
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / DUR)
      const v = open ? ease(p) * 4 : (1 - ease(p)) * 4
      const style = el.style as CSSStyleDeclaration & { webkitBackdropFilter?: string }
      style.backdropFilter = `blur(${v.toFixed(2)}px)`
      style.webkitBackdropFilter = `blur(${v.toFixed(2)}px)`
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(raf)
      const style = el.style as CSSStyleDeclaration & { webkitBackdropFilter?: string }
      style.backdropFilter = ''
      style.webkitBackdropFilter = ''
    }
  }, [open])

  // macOS WKWebView 焦点恢复（原生壳）：ESC 关闭时 WebKit 在 NSEvent 层结束
  // 文本输入会话并使 webview 失去 first responder——之后的 ⌘K/⌘J/⌘\ 不再送达
  // 页面（系统只蜂鸣），需手动点击才恢复。关闭后把 DOM 焦点显式交回 body
  // （tabindex=-1 可编程聚焦），等价一次页面内激活；纯浏览器无副作用故跳过。
  useEffect(() => {
    if (open) return
    if (!isNativeShell()) return
    requestAnimationFrame(() => {
      document.body.tabIndex = -1
      document.body.focus({ preventScroll: true })
    })
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
        title: t('command.newDoc'),
        hint: t('command.newDocHint'),
        section: 'command',
        shortcut: ['mod', 'N'],
        keywords: ['create', 'doc', 'new', '新建'],
        action: () => { onClose(); navigate('/new') },
      },
      {
        id: 'cmd-home',
        icon: Hash,
        title: t('command.goHome'),
        hint: t('command.goHomeHint'),
        section: 'command',
        keywords: ['home', 'list', 'index', '首页'],
        action: () => { onClose(); navigate('/') },
      },
      {
        id: 'cmd-theme',
        icon: dark ? Sun : Moon,
        title: dark ? t('command.switchToLight') : t('command.switchToDark'),
        hint: t('command.toggleThemeHint'),
        section: 'command',
        shortcut: ['mod', '⇧D'],
        keywords: ['theme', 'dark', 'light', '主题'],
        action: toggleDark,
      },
    ]
  }, [dark, navigate, onClose, t])

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
      aria-label={t('command.dialogLabel')}
    >
      {/* 遮罩：blur 由 rAF 逐帧驱动（见上），黑色经外层 opacity 过渡淡入——两者同步，无二段式 */}
      <div
        ref={maskRef}
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div className={`relative w-full max-w-xl bg-popover rounded-2xl border border-border shadow-2xl overflow-hidden transition-transform duration-[var(--dur)] ease-[var(--ease)] ${open ? 'translate-y-0 scale-100' : 'translate-y-2 scale-[0.98]'}`}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('command.placeholder')}
            className="flex-1 bg-transparent text-base text-foreground placeholder:text-muted-foreground outline-none"
          />
          <Kbd className="text-[11px]">esc</Kbd>
        </div>

        <div ref={listRef} className="max-h-[60vh] overflow-y-auto p-2">
          {allItems.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              {searching ? t('command.searching') : query ? t('command.noResults') : t('command.hint')}
            </div>
          )}

          {commandSection.length > 0 && (
            <SectionLabel>{t('command.commands')}</SectionLabel>
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
            <SectionLabel>{query ? t('command.docs') : t('command.recentDocs')}</SectionLabel>
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
              {t('command.select')}
            </span>
            <span className="inline-flex items-center gap-1">
              <CornerDownLeft className="w-3 h-3" />
              {t('command.open')}
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>esc</Kbd>
              {t('command.close')}
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
          : 'text-foreground/80 hover:bg-[var(--primary-softer)]')
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
        <ShortcutKeys keys={item.shortcut} className="shrink-0" />
      )}
    </button>
  )
}