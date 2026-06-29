import { useState, useCallback, useRef, useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { BookOpen, Search, FileText, PanelLeftClose, PanelLeft, Plus, Moon } from 'lucide-react'
import type { SearchResult } from '@notefast/core'
import { request } from '../hooks/useAPI'

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
}

export default function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [showCommands, setShowCommands] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const paletteRef = useRef<HTMLDivElement>(null)

  const handleNewDoc = useCallback(() => {
    setShowCommands(false)
    navigate('/new')
  }, [navigate])

  const toggleDarkMode = useCallback(() => {
    setShowCommands(false)
    document.documentElement.classList.toggle('dark')
    localStorage.setItem('theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light')
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setShowCommands(true)
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        handleNewDoc()
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        toggleDarkMode()
      }
      if (e.key === 'Escape') {
        setShowCommands(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleNewDoc, toggleDarkMode])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (paletteRef.current && !paletteRef.current.contains(e.target as Node) && !searchInputRef.current?.contains(e.target as Node)) {
        setShowCommands(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleSearch = useCallback(async (q: string) => {
    setQuery(q)
    if (q.trim().length < 2) { setResults([]); setSearchOpen(false); return }
    setSearching(true)
    try {
      const params = new URLSearchParams({ q: q, limit: '8' })
      const res = await request<SearchResult[]>('/search?' + params.toString())
      setResults(res)
      setSearchOpen(res.length > 0)
    } catch { setResults([]) }
    finally { setSearching(false) }
  }, [])

  const handleSelect = (docId: string) => {
    setSearchOpen(false); setQuery(''); navigate('/doc/' + docId)
  }

  if (collapsed) {
    return (
      <aside className="w-14 flex flex-col items-center py-3 border-r border-warm-200 dark:border-warm-700 bg-white dark:bg-warm-800 shrink-0">
        <button onClick={onToggle} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-warm-100 dark:hover:bg-warm-700 text-warm-400 hover:text-warm-600 dark:hover:text-warm-200 transition-colors mb-4" title="展开侧边栏">
          <PanelLeft className="w-4 h-4" />
        </button>
        <Link to="/" className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-warm-100 dark:hover:bg-warm-700 text-warm-400 hover:text-brand-500 transition-colors" title="文档">
          <FileText className="w-4 h-4" />
        </Link>
      </aside>
    )
  }

  return (
    <aside className="w-60 flex flex-col border-r border-warm-200 dark:border-warm-700 bg-white dark:bg-warm-800 shrink-0 h-full">
      <div className="h-12 flex items-center justify-between px-3 border-b border-warm-100 dark:border-warm-700">
        <Link to="/" className="flex items-center gap-2 font-semibold text-sm text-warm-900 dark:text-warm-50 hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
          <BookOpen className="w-4 h-4" />
          NoteFast
        </Link>
        <button onClick={onToggle} className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-warm-100 dark:hover:bg-warm-700 text-warm-400 hover:text-warm-600 dark:hover:text-warm-200 transition-colors" title="折叠侧边栏">
          <PanelLeftClose className="w-4 h-4" />
        </button>
      </div>
      <div className="px-3 pt-3 pb-2 relative">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-warm-400" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="搜索... (⌘K)"
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-sm rounded-lg border border-warm-200 dark:border-warm-700 bg-warm-50 dark:bg-warm-900 text-warm-900 dark:text-warm-50 placeholder:text-warm-400 focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-300 dark:focus:border-brand-600 transition-all"
          />
          {searching && (
            <div className="absolute right-2.5 top-1/2 -translate-y-1/2">
              <div className="w-3.5 h-3.5 border-2 border-brand-400 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>
        {showCommands && (
          <div ref={paletteRef} className="absolute top-full left-3 right-3 mt-1 bg-white/95 dark:bg-warm-800/95 backdrop-blur-md rounded-xl border border-warm-200 dark:border-warm-700 shadow-lg z-50 p-1.5">
            <div className="text-[10px] text-warm-400 px-3 py-1.5 uppercase tracking-wider">操作</div>
            <button onClick={handleNewDoc} className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-warm-700 dark:text-warm-200 hover:bg-warm-100 dark:hover:bg-warm-700 transition-colors text-left">
              <Plus className="w-4 h-4 text-warm-400" />
              <span>新建文档 New doc</span>
              <span className="ml-auto text-[10px] text-warm-400 font-mono">⌘N</span>
            </button>
            <button onClick={toggleDarkMode} className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-warm-700 dark:text-warm-200 hover:bg-warm-100 dark:hover:bg-warm-700 transition-colors text-left">
              <Moon className="w-4 h-4 text-warm-400" />
              <span>切换主题 Toggle theme</span>
              <span className="ml-auto text-[10px] text-warm-400 font-mono">⌘⇧D</span>
            </button>
          </div>
        )}
        {searchOpen && (
          <div className="absolute left-3 right-3 top-full mt-1 bg-white dark:bg-warm-800 border border-warm-200 dark:border-warm-700 rounded-lg shadow-lg max-h-72 overflow-y-auto z-30">
            {results.map((r) => (
              <button
                key={r.block.id}
                onClick={() => handleSelect(r.block.root_id)}
                className="block w-full text-left px-3 py-2 hover:bg-warm-50 dark:hover:bg-warm-700 border-b border-warm-100 dark:border-warm-700 last:border-b-0 transition-colors"
              >
                <p className="text-[10px] text-warm-400 uppercase tracking-wide mb-0.5">{r.block.type}</p>
                <p className="text-xs text-warm-700 dark:text-warm-200 line-clamp-2 leading-snug">{r.snippet}</p>
              </button>
            ))}
          </div>
        )}
      </div>
      <nav className="px-2 py-2 flex-1 overflow-y-auto">
        <div className="text-[10px] font-medium text-warm-400 uppercase tracking-wider px-2 mb-1">导航</div>
        <Link
          to="/"
          className={location.pathname === '/' ? 'sidebar-link-active' : 'sidebar-link'}
        >
          <FileText className="w-4 h-4" />
          所有文档
        </Link>
      </nav>
      <div className="px-3 py-2 border-t border-warm-100 dark:border-warm-700">
        <p className="text-[10px] text-warm-400">NoteFast v0.1.0</p>
      </div>
    </aside>
  )
}