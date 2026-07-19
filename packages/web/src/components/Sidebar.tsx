import { useCallback, useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  BookOpen,
  Search,
  FileText,
  PanelLeftClose,
  PanelLeft,
  Plus,
  Clock,
  MessageSquareText,
} from 'lucide-react'
import { api } from '../hooks/useAPI'
import type { DocSummary } from '@notefast/core'

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
  onOpenPalette: () => void
  onOpenChat?: () => void
  onNavigate?: () => void
}

/**
 * Sidebar section 分组标签
 *
 * 风格参考 Notion：每组最前面是 `—` hairline（适度宽），后跟全大写细字号 label。
 * 让分组一眼能看出"行政层次"——不是"一长串列表"。
 */
function SidebarSectionLabel({
  label,
  icon,
}: {
  label: string
  icon?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2 px-2 mb-1.5 select-none">
      <span className="block h-px w-3 bg-sidebar-border" />
      {icon && <span className="text-sidebar-muted/70 shrink-0">{icon}</span>}
      <span className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-sidebar-muted/75">
        {label}
      </span>
    </div>
  )
}

export default function Sidebar({
  collapsed,
  onToggle,
  onOpenPalette,
  onOpenChat,
  onNavigate,
}: SidebarProps) {
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
      <aside className="w-14 flex flex-col items-center py-3 border-r border-sidebar-border bg-sidebar shrink-0 h-full relative">
        <div className="h-14 w-full flex items-center justify-center border-b border-sidebar-border shrink-0 absolute top-0 left-0 bg-sidebar">
          <button onClick={onToggle} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-sidebar-accent text-sidebar-muted hover:text-sidebar-accent-foreground transition-colors group" title="展开侧边栏">
            <PanelLeft className="w-4 h-4 opacity-50 group-hover:opacity-100 transition-opacity" strokeWidth={1.75} />
          </button>
        </div>
        <div className="mt-14 w-full flex flex-col items-center pt-4">
          <Link to="/" className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-sidebar-accent text-sidebar-muted hover:text-primary transition-colors" title="文档">
            <FileText className="w-4 h-4" strokeWidth={1.75} />
          </Link>
        </div>
      </aside>
    )
  }

  return (
    <aside className="w-60 flex flex-col border-r border-sidebar-border bg-sidebar shrink-0 h-full">
      <div className="h-14 flex items-center justify-between px-3 border-b border-sidebar-border shrink-0">
        <div className="flex items-center gap-2">
          <Link to="/" onClick={closeAfterNav} className="flex items-center gap-2 font-semibold text-[15px] text-foreground hover:text-foreground/80 transition-colors tracking-[-0.01em]">
            <span className="w-7 h-7 grid place-items-center rounded-md bg-foreground text-background">
              <BookOpen className="w-3.5 h-3.5" strokeWidth={2.25} />
            </span>
            NoteFast
          </Link>
          <span
            className="text-[10px] font-medium uppercase tracking-[0.06em] px-1.5 py-[1px] rounded border border-border/60 text-muted-foreground/80 bg-muted/40"
            title="NoteFast v0.1"
          >
            Beta
          </span>
        </div>
        <button onClick={onToggle} className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-sidebar-accent text-sidebar-muted hover:text-sidebar-accent-foreground transition-colors group" title="折叠侧边栏">
          <PanelLeftClose className="w-4 h-4 opacity-50 group-hover:opacity-100 transition-opacity" strokeWidth={1.75} />
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

      <nav className="px-2 pt-2 pb-1 flex-1 overflow-y-auto">
        <SidebarSectionLabel label="导航" icon={<FileText className="w-3.5 h-3.5" strokeWidth={1.75} />} />
        <Link to="/" onClick={closeAfterNav} className={location.pathname === '/' ? 'sidebar-link-active' : 'sidebar-link'}>
          所有文档
        </Link>
        <Link to="/new" onClick={closeAfterNav} className={location.pathname === '/new' ? 'sidebar-link-active' : 'sidebar-link'}>
          <Plus className="w-[18px] h-[18px]" strokeWidth={1.75} />
          新建
        </Link>

        {recentDocs.length > 0 && (
          <div className="mt-5 pt-3 border-t border-sidebar-border/60">
            <SidebarSectionLabel label="最近文档" icon={<Clock className="w-3.5 h-3.5" strokeWidth={1.75} />} />
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

      <div className="border-t border-sidebar-border shrink-0">
        <div className="px-3 pt-3 pb-2 flex items-center gap-1.5">
          <button
            type="button"
            onClick={onOpenPalette}
            className="flex-1 inline-flex items-center justify-between gap-2 px-2 py-1 rounded-md text-[12px] text-sidebar-muted hover:text-foreground hover:bg-sidebar-accent transition-colors"
            title="搜索文档"
          >
            <span className="inline-flex items-center gap-1.5">
              <Search className="w-3.5 h-3.5" strokeWidth={1.75} />
              搜索
            </span>
            <kbd className="font-mono text-[10px] px-1 py-px border border-sidebar-border rounded text-sidebar-muted">
              {isMac ? '⌘' : 'Ctrl'}K
            </kbd>
          </button>
          <button
            type="button"
            onClick={onOpenChat}
            className="inline-flex items-center justify-center w-7 h-7 rounded-md text-sidebar-muted hover:text-foreground hover:bg-sidebar-accent transition-colors"
            title="与知识库对话（⌘J）"
            aria-label="聊天"
          >
            <MessageSquareText className="w-3.5 h-3.5" strokeWidth={1.75} />
          </button>
        </div>
        <div className="px-3 py-1.5 flex items-center justify-between gap-2">
          <a
            href="/settings"
            className="text-[10px] text-sidebar-muted/65 hover:text-foreground transition-colors"
          >
            设置
          </a>
          <span className="text-[10px] font-mono tabular-nums text-sidebar-muted/55">v0.1.0</span>
        </div>
      </div>
    </aside>
  )
}
