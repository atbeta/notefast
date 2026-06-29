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
      <aside className="w-14 flex flex-col items-center py-3 border-r border-sidebar-border bg-sidebar shrink-0">
        <button onClick={onToggle} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-sidebar-accent text-sidebar-muted hover:text-sidebar-accent-foreground transition-colors mb-4" title="展开侧边栏">
          <PanelLeft className="w-4 h-4" />
        </button>
        <Link to="/" className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-sidebar-accent text-sidebar-muted hover:text-primary transition-colors" title="文档">
          <FileText className="w-4 h-4" />
        </Link>
      </aside>
    )
  }

  return (
    <aside className="w-60 flex flex-col border-r border-sidebar-border bg-sidebar shrink-0 h-full">
      <div className="h-12 flex items-center justify-between px-3 border-b border-sidebar-border">
        <Link to="/" className="flex items-center gap-2 font-semibold text-sm text-foreground hover:text-primary transition-colors">
          <BookOpen className="w-4 h-4" />
          NoteFast
        </Link>
        <button onClick={onToggle} className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-sidebar-accent text-sidebar-muted hover:text-sidebar-accent-foreground transition-colors" title="折叠侧边栏">
          <PanelLeftClose className="w-4 h-4" />
        </button>
      </div>
      <div className="px-3 pt-3 pb-2 relative">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="搜索... (⌘K)"
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-sm rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-ring transition-all"
          />
          {searching && (
            <div className="absolute right-2.5 top-1/2 -translate-y-1/2">
              <div className="w-3.5 h-3.5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>
        {showCommands && (
          <div ref={paletteRef} className="absolute top-full left-3 right-3 mt-1 bg-popover/95 backdrop-blur-md rounded-xl border border-border shadow-lg z-50 p-1.5">
            <div className="text-[10px] text-muted-foreground px-3 py-1.5 uppercase tracking-wider">操作</div>
            <button onClick={handleNewDoc} className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-foreground hover:bg-accent transition-colors text-left">
              <Plus className="w-4 h-4 text-muted-foreground" />
              <span>新建文档 New doc</span>
              <span className="ml-auto text-[10px] text-muted-foreground font-mono">⌘N</span>
            </button>
            <button onClick={toggleDarkMode} className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-foreground hover:bg-accent transition-colors text-left">
              <Moon className="w-4 h-4 text-muted-foreground" />
              <span>切换主题 Toggle theme</span>
              <span className="ml-auto text-[10px] text-muted-foreground font-mono">⌘⇧D</span>
            </button>
          </div>
        )}
        {searchOpen && (
          <div className="absolute left-3 right-3 top-full mt-1 bg-popover border border-border rounded-lg shadow-lg max-h-72 overflow-y-auto z-30">
            {results.map((r) => (
              <button
                key={r.block.id}
                onClick={() => handleSelect(r.block.root_id)}
                className="block w-full text-left px-3 py-2 hover:bg-accent border-b border-border last:border-b-0 transition-colors"
              >
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">{r.block.type}</p>
                <p className="text-xs text-foreground line-clamp-2 leading-snug">{r.snippet}</p>
              </button>
            ))}
          </div>
        )}
      </div>
      <nav className="px-2 py-2 flex-1 overflow-y-auto">
        <div className="text-[10px] font-medium text-sidebar-muted uppercase tracking-wider px-2 mb-1">导航</div>
        <Link
          to="/"
          className={location.pathname === '/' ? 'sidebar-link-active' : 'sidebar-link'}
        >
          <FileText className="w-4 h-4" />
          所有文档
        </Link>
      </nav>
      <div className="px-3 py-2 border-t border-sidebar-border">
        <p className="text-[10px] text-sidebar-muted">NoteFast v0.1.0</p>
      </div>
    </aside>
  )
}
