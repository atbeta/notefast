import { useCallback, useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { BookOpen, Search, FileText, PanelLeftClose, PanelLeft, Plus, Clock } from 'lucide-react'
import { api } from '../hooks/useAPI'
import type { DocSummary } from '@notefast/core'

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
  onOpenPalette: () => void
  onNavigate?: () => void
}

export default function Sidebar({ collapsed, onToggle, onOpenPalette, onNavigate }: SidebarProps) {
  const location = useLocation()
  const [isMac, setIsMac] = useState(false)
  const [recentDocs, setRecentDocs] = useState<DocSummary[]>([])

  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/i.test(navigator.platform))
  }, [])

  useEffect(() => {
    if (!collapsed) {
      api.get<DocSummary[]>('/docs/list')
        .then((list) => setRecentDocs(list.slice(0, 15)))
        .catch(() => {})
    }
  }, [collapsed, location.pathname])

  const closeAfterNav = useCallback(() => {
    onNavigate?.()
  }, [onNavigate])

  if (collapsed) {
    return (
      <aside className="w-14 flex flex-col items-center py-3 border-r border-sidebar-border bg-sidebar shrink-0">
        <button onClick={onToggle} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-sidebar-accent text-sidebar-muted hover:text-sidebar-accent-foreground transition-colors mb-4" title="展开侧边栏">
          <PanelLeft className="w-4 h-4" strokeWidth={1.75} />
        </button>
        <Link to="/" className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-sidebar-accent text-sidebar-muted hover:text-primary transition-colors" title="文档">
          <FileText className="w-4 h-4" strokeWidth={1.75} />
        </Link>
      </aside>
    )
  }

  return (
    <aside className="w-60 flex flex-col border-r border-sidebar-border bg-sidebar shrink-0 h-full">
      <div className="h-12 flex items-center justify-between px-3 border-b border-sidebar-border shrink-0">
        <Link to="/" onClick={closeAfterNav} className="flex items-center gap-2 font-semibold text-[15px] text-foreground hover:text-foreground/80 transition-colors tracking-[-0.01em]">
          <span className="w-7 h-7 grid place-items-center rounded-md bg-foreground text-background">
            <BookOpen className="w-3.5 h-3.5" strokeWidth={2.25} />
          </span>
          NoteFast
        </Link>
        <button onClick={onToggle} className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-sidebar-accent text-sidebar-muted hover:text-sidebar-accent-foreground transition-colors" title="折叠侧边栏">
          <PanelLeftClose className="w-4 h-4" strokeWidth={1.75} />
        </button>
      </div>

      <div className="px-3 pt-3 pb-2 shrink-0">
        <button
          type="button"
          onClick={onOpenPalette}
          className="group w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-border bg-background text-muted-foreground hover:text-foreground hover:border-foreground/15 transition-colors text-[13px]"
          aria-label="打开命令面板"
        >
          <Search className="w-3.5 h-3.5" strokeWidth={1.75} />
          <span className="flex-1 text-left">搜索文档…</span>
          <kbd className="font-mono text-[10px] px-1.5 py-0.5 border border-border rounded bg-card text-muted-foreground/80">
            {isMac ? '⌘' : 'Ctrl'}K
          </kbd>
        </button>
      </div>

      <nav className="px-2 py-2 flex-1 overflow-y-auto">
        <div className="text-[11px] font-medium text-sidebar-muted/80 px-2 mb-1.5">导航</div>
        <Link to="/" onClick={closeAfterNav} className={location.pathname === '/' ? 'sidebar-link-active' : 'sidebar-link'}>
          <FileText className="w-[18px] h-[18px]" strokeWidth={1.75} />
          所有文档
        </Link>
        <Link to="/new" onClick={closeAfterNav} className={location.pathname === '/new' ? 'sidebar-link-active' : 'sidebar-link'}>
          <Plus className="w-[18px] h-[18px]" strokeWidth={1.75} />
          新建
        </Link>

        {recentDocs.length > 0 && (
          <div className="mt-6">
            <div className="text-[11px] font-medium text-sidebar-muted/80 px-2 mb-1.5 flex items-center gap-1.5">
              <Clock className="w-3 h-3" strokeWidth={1.75} />
              最近文档
            </div>
            <div className="flex flex-col gap-0.5">
              {recentDocs.map(doc => {
                const isActive = location.pathname === `/doc/${doc.id}`
                return (
                  <Link
                    key={doc.id}
                    to={`/doc/${doc.id}`}
                    onClick={closeAfterNav}
                    className={`px-2.5 py-1 rounded-md text-[13px] truncate transition-colors ${
                      isActive
                        ? 'bg-primary/8 text-primary font-medium'
                        : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                    }`}
                    title={doc.title}
                  >
                    {doc.title || '无标题文档'}
                  </Link>
                )
              })}
            </div>
          </div>
        )}
      </nav>

      <div className="px-3 py-2 border-t border-sidebar-border shrink-0">
        <p className="text-[10px] text-sidebar-muted">NoteFast v0.1.0</p>
      </div>
    </aside>
  )
}
