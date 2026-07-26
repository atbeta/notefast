import { useCallback, useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  BookOpen,
  Search,
  FileText,
  PanelLeftClose,
  PanelLeft,
  Plus,
  LayoutGrid,
  Inbox,
  Sparkles,
  Settings,
  Tag,
  Link2,
  Star,
  X,
} from 'lucide-react'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import { useDocChanges } from '../hooks/useDocEvents'
import { usePinnedViews } from '../hooks/usePinnedViews'
import type { DocSummary } from '@notefast/core'

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
  onOpenPalette: () => void
  onNavigate?: () => void
  /** AI 聊天面板状态与开关 — 入口收敛在侧边栏导航，替代右下角 FAB */
  aiChatOpen?: boolean
  onToggleAiChat?: () => void
}

/**
 * Sidebar section 分组标签
 *
 * Notion 式纯文字 micro-label：无 hairline、无图标，
 * 与下方列表项同一左 padding，基线自然对齐。
 */
function SidebarSectionLabel({ label }: { label: string }) {
  return (
    <div className="px-2.5 mb-1 select-none">
      <span className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-sidebar-muted/80">
        {label}
      </span>
    </div>
  )
}

export default function Sidebar({
  collapsed,
  onToggle,
  onOpenPalette,
  onNavigate,
  aiChatOpen,
  onToggleAiChat,
}: SidebarProps) {
  const location = useLocation()
  const [isMac, setIsMac] = useState(false)
  const [inboxCount, setInboxCount] = useState(0)
  const [autolinkCount, setAutolinkCount] = useState(0)
  const { views: pinnedViews, unpin } = usePinnedViews()

  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/i.test(navigator.platform))
  }, [])

  /** 实例版本号（/api/v1/version），加载完成前不渲染版本位；失败静默 */
  const { data: versionInfo } = useApiQuery(() => api.get<{ version: string }>('/version'), [])
  const version = versionInfo?.version ?? null

  /**
   * 最近文档：折叠态不展示也不发请求（挂起的 Promise 保持旧数据，重新展开时无闪烁）；
   * 展开 / 路由变化时重拉，失败静默保留旧数据
   */
  const { data: docList, refetch: refetchRecent } = useApiQuery(
    () => (collapsed ? new Promise<DocSummary[]>(() => {}) : api.get<DocSummary[]>('/docs/list')),
    [collapsed, location.pathname],
  )
  const recentDocs = (docList ?? []).slice(0, 15)

  // 外部 MCP / AI 聊天等任何通道写入文档 → 即时刷新最近列表（服务端已聚合去抖）
  useDocChanges(
    useCallback(() => {
      if (!collapsed) refetchRecent()
    }, [collapsed, refetchRecent]),
  )

  // 收集箱计数 + 链接建议未读计数
  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      api.get<DocSummary[]>('/docs/list?status=inbox')
        .then((list) => { if (!cancelled) setInboxCount(list.length) })
        .catch(() => {})
      api.get<{ count: number }>('/auto-link/inbox?status=unreviewed&limit=1')
        .then((r) => { if (!cancelled) setAutolinkCount(r.count) })
        .catch(() => {})
    }
    refresh()
    const t = setInterval(refresh, 15_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [location.pathname])

  const closeAfterNav = useCallback(() => {
    onNavigate?.()
  }, [onNavigate])

  if (collapsed) {
    return (
      <aside className="w-14 flex flex-col items-center py-3 shrink-0 h-full relative bg-sidebar border-r border-border/50">
        <div className="h-14 w-full flex items-center justify-center border-b border-border/50 shrink-0 absolute top-0 left-0">
          <button onClick={onToggle} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-sidebar-accent text-sidebar-muted hover:text-sidebar-accent-foreground transition-colors group" title="展开侧边栏">
            <PanelLeft className="w-4 h-4 opacity-50 group-hover:opacity-100 transition-opacity" strokeWidth={1.75} />
          </button>
        </div>
        <div className="mt-14 w-full flex flex-col items-center pt-4 gap-1">
          <Link to="/" className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-sidebar-accent text-sidebar-muted hover:text-primary transition-colors" title="文档">
            <FileText className="w-4 h-4" strokeWidth={1.75} />
          </Link>
          {onToggleAiChat && (
            <button
              type="button"
              onClick={onToggleAiChat}
              className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors ${
                aiChatOpen
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
              }`}
              title="AI 助手"
            >
              <Sparkles className="w-4 h-4" strokeWidth={1.75} />
            </button>
          )}
          <div className="flex-1" />
          <Link
            to="/settings"
            className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors ${
              location.pathname.startsWith('/settings')
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-muted/70 hover:text-sidebar-accent-foreground hover:bg-sidebar-accent'
            }`}
            title="设置"
          >
            <Settings className="w-3.5 h-3.5" strokeWidth={1.75} />
          </Link>
        </div>
      </aside>
    )
  }

  return (
    <aside className="w-60 flex flex-col shrink-0 h-full bg-sidebar border-r border-border/50">
      <div className="h-14 flex items-center justify-between px-3 border-b border-border/50 shrink-0">
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
        <SidebarSectionLabel label="导航" />
        <Link to="/" onClick={closeAfterNav} className={location.pathname === '/' && !location.search ? 'sidebar-link-active' : 'sidebar-link'}>
          <LayoutGrid className="w-[15px] h-[15px]" strokeWidth={1.75} />
          所有文档
        </Link>
        <Link to="/new" onClick={closeAfterNav} className={location.pathname === '/new' ? 'sidebar-link-active' : 'sidebar-link'}>
          <Plus className="w-[15px] h-[15px]" strokeWidth={1.75} />
          新建
        </Link>
        <Link to="/inbox" onClick={closeAfterNav} className={location.pathname === '/inbox' ? 'sidebar-link-active' : 'sidebar-link'}>
          <Inbox className="w-[15px] h-[15px]" strokeWidth={1.75} />
          <span className="flex-1">收集箱</span>
          {inboxCount > 0 && (
            <span className="ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full text-[10px] font-medium bg-foreground text-background tabular-nums">
              {inboxCount > 99 ? '99+' : inboxCount}
            </span>
          )}
        </Link>
        <Link to="/autolink" onClick={closeAfterNav} className={location.pathname === '/autolink' ? 'sidebar-link-active' : 'sidebar-link'}>
          <Link2 className="w-[15px] h-[15px]" strokeWidth={1.75} />
          <span className="flex-1">链接建议</span>
          {autolinkCount > 0 && (
            <span className="ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full text-[10px] font-medium bg-foreground text-background tabular-nums">
              {autolinkCount > 99 ? '99+' : autolinkCount}
            </span>
          )}
        </Link>
        {onToggleAiChat && (
          <button
            type="button"
            onClick={onToggleAiChat}
            className={`w-full text-left ${aiChatOpen ? 'sidebar-link-active' : 'sidebar-link'}`}
          >
            <Sparkles className="w-[15px] h-[15px]" strokeWidth={1.75} />
            <span className="flex-1">AI 助手</span>
            <kbd className="ml-auto font-mono text-[10px] text-sidebar-muted/70">
              {isMac ? '⌘' : 'Ctrl'}J
            </kbd>
          </button>
        )}

        <div className="mt-5">
          <SidebarSectionLabel label="智能视图" />
          <Link
            to="/?view=untagged"
            onClick={closeAfterNav}
            className={location.search.includes('untagged') || location.search.includes('view=untagged') ? 'sidebar-link-active' : 'sidebar-link'}
          >
            <Tag className="w-[15px] h-[15px]" strokeWidth={1.75} />
            未打标
          </Link>
        </div>

        {pinnedViews.length > 0 && (
          <div className="mt-5">
            <SidebarSectionLabel label="固定视图" />
            {pinnedViews.map((v) => (
              <div key={v.id} className="group flex items-center gap-1">
                <Link
                  to={`/?${v.query}`}
                  onClick={closeAfterNav}
                  className={`flex-1 px-2.5 py-1 rounded-md text-[13px] truncate transition-colors ${
                    location.search === `?${v.query}`
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                      : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                  }`}
                  title={v.name}
                >
                  <span className="flex items-center gap-1.5">
                    <Star className="w-[11px] h-[11px] shrink-0" strokeWidth={2} />
                    {v.name}
                  </span>
                </Link>
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); unpin(v.id) }}
                  className="p-0.5 rounded opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 transition-all shrink-0"
                  title="取消固定"
                >
                  <X className="w-3 h-3" strokeWidth={2} />
                </button>
              </div>
            ))}
          </div>
        )}

        {recentDocs.length > 0 && (
          <div className="mt-5">
            <SidebarSectionLabel label="最近文档" />
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
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
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
        <div className="px-3 pt-2 pb-2.5 flex items-center justify-between gap-2">
          <Link
            to="/settings"
            onClick={closeAfterNav}
            title="设置"
            aria-label="设置"
            className={`w-6 h-6 flex items-center justify-center rounded-md transition-colors ${
              location.pathname.startsWith('/settings')
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-muted/70 hover:text-sidebar-accent-foreground hover:bg-sidebar-accent'
            }`}
          >
            <Settings className="w-3.5 h-3.5" strokeWidth={1.75} />
          </Link>
          {version && (
            <span className="text-[10px] font-mono tabular-nums text-sidebar-muted/55">v{version}</span>
          )}
        </div>
      </div>
    </aside>
  )
}
