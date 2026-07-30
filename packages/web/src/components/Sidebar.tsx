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
  Archive,
  Sparkles,
  Settings,
  Tag,
  Star,
  X,
  Clock,
  Hourglass,
  EyeOff,
  Waypoints,
} from 'lucide-react'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import { useDocChanges } from '../hooks/useDocEvents'
import { usePinnedViews, canonicalViewQuery } from '../hooks/usePinnedViews'
import { useScrollFade } from '../hooks/useScrollFade'
import { DRAFT_CHANGED_EVENT, hasDraftSync } from '../hooks/useEditorDraft'
import type { DocSummary } from '@notefast/core'
import DocActionsMenu from './DocActionsMenu'
import { Tooltip, ShortcutKeys, shortcutLabel } from './ui'

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
  const [inboxCount, setInboxCount] = useState(0)
  const [archivedCount, setArchivedCount] = useState(0)
  const { views: pinnedViews, unpin } = usePinnedViews()
  const navFadeRef = useScrollFade<HTMLElement>()

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

  // 草稿圆点：逐条同步探测 + 订阅草稿变更事件（编辑器防抖暂存后实时出现/消失）
  const [draftIds, setDraftIds] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const compute = () => {
      const ids = new Set<string>()
      for (const d of recentDocs) {
        if (hasDraftSync(d.id)) ids.add(d.id)
      }
      // 内容相同就复用旧 Set——recentDocs 每次渲染都是新数组 identity，effect 会
      // 随之反复触发，若无条件 setState 新 identity 将构成「渲染→effect→渲染」死循环
      setDraftIds((prev) =>
        prev.size === ids.size && [...ids].every((x) => prev.has(x)) ? prev : ids,
      )
    }
    compute()
    window.addEventListener(DRAFT_CHANGED_EVENT, compute)
    return () => window.removeEventListener(DRAFT_CHANGED_EVENT, compute)
  }, [recentDocs])

  // 外部 MCP / AI 聊天等任何通道写入文档 → 即时刷新最近列表（服务端已聚合去抖）
  useDocChanges(
    useCallback(() => {
      if (!collapsed) refetchRecent()
    }, [collapsed, refetchRecent]),
  )

  // 收集箱计数 + 归档计数
  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      api.get<DocSummary[]>('/docs/list?status=inbox')
        .then((list) => { if (!cancelled) setInboxCount(list.length) })
        .catch(() => {})
      api.get<DocSummary[]>('/docs/list?status=archived')
        .then((list) => { if (!cancelled) setArchivedCount(list.length) })
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
          <Tooltip label="展开侧边栏">
            <button onClick={onToggle} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-sidebar-accent text-sidebar-muted hover:text-sidebar-accent-foreground transition-colors group">
              <PanelLeft className="w-4 h-4 opacity-50 group-hover:opacity-100 transition-opacity" strokeWidth={1.75} />
            </button>
          </Tooltip>
        </div>
        <div className="mt-14 w-full flex-1 flex flex-col items-center pt-4 gap-1">
          <Tooltip label="文档">
            <Link to="/" className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-sidebar-accent text-sidebar-muted hover:text-primary transition-colors">
              <FileText className="w-4 h-4" strokeWidth={1.75} />
            </Link>
          </Tooltip>
          {onToggleAiChat && (
            <Tooltip label="AI 助手">
              <button
                type="button"
                onClick={onToggleAiChat}
                className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors ${
                  aiChatOpen
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                }`}
              >
                <Sparkles className="w-4 h-4" strokeWidth={1.75} />
              </button>
            </Tooltip>
          )}
          <div className="flex-1" />
          <Tooltip label="设置">
            <Link
              to="/settings"
              className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors ${
                location.pathname.startsWith('/settings')
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-muted/70 hover:text-sidebar-accent-foreground hover:bg-sidebar-accent'
              }`}
            >
              <Settings className="w-3.5 h-3.5" strokeWidth={1.75} />
            </Link>
          </Tooltip>
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
        <Tooltip label="折叠侧边栏">
          <button onClick={onToggle} className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-sidebar-accent text-sidebar-muted hover:text-sidebar-accent-foreground transition-colors group">
            <PanelLeftClose className="w-4 h-4 opacity-50 group-hover:opacity-100 transition-opacity" strokeWidth={1.75} />
          </button>
        </Tooltip>
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
          <ShortcutKeys keys={['mod', 'K']} />
        </button>
      </div>

      <nav ref={navFadeRef} className="scroll-fade px-2 pt-2 pb-1 flex-1 overflow-y-auto">
        <SidebarSectionLabel label="导航" />
        <Link to="/" onClick={closeAfterNav} className={location.pathname === '/' && !location.search ? 'sidebar-link-active' : 'sidebar-link'}>
          <LayoutGrid className="w-[15px] h-[15px]" strokeWidth={1.75} />
          所有文档
        </Link>
        <Link to="/new" onClick={closeAfterNav} className={location.pathname === '/new' ? 'sidebar-link-active' : 'sidebar-link'} title={`新建文档 (${shortcutLabel(['mod', 'N'])})`}>
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
        <Link to="/archived" onClick={closeAfterNav} className={location.pathname === '/archived' ? 'sidebar-link-active' : 'sidebar-link'}>
          <Archive className="w-[15px] h-[15px]" strokeWidth={1.75} />
          <span className="flex-1">归档</span>
          {archivedCount > 0 && (
            <span className="ml-auto text-[10px] text-sidebar-muted/70 tabular-nums">
              {archivedCount > 99 ? '99+' : archivedCount}
            </span>
          )}
        </Link>
        <Link to="/entities" onClick={closeAfterNav} className={location.pathname === '/entities' ? 'sidebar-link-active' : 'sidebar-link'}>
          <Waypoints className="w-[15px] h-[15px]" strokeWidth={1.75} />
          <span className="flex-1">实体</span>
        </Link>
        {onToggleAiChat && (
          <button
            type="button"
            onClick={onToggleAiChat}
            className={`w-full text-left ${aiChatOpen ? 'sidebar-link-active' : 'sidebar-link'}`}
          >
            <Sparkles className="w-[15px] h-[15px]" strokeWidth={1.75} />
            <span className="flex-1">AI 助手</span>
            <ShortcutKeys keys={['mod', 'J']} className="ml-auto" />
          </button>
        )}

        <div className="mt-5">
          <SidebarSectionLabel label="智能视图" />
          <Link
            to="/?updated_within=7d"
            onClick={closeAfterNav}
            className={location.search.includes('updated_within=7d') ? 'sidebar-link-active' : 'sidebar-link'}
          >
            <Clock className="w-[15px] h-[15px]" strokeWidth={1.75} />
            最近 7 天更新
          </Link>
          <Link
            to="/?stale_within=90d"
            onClick={closeAfterNav}
            className={location.search.includes('stale_within=90d') ? 'sidebar-link-active' : 'sidebar-link'}
          >
            <Hourglass className="w-[15px] h-[15px]" strokeWidth={1.75} />
            90 天未更新
          </Link>
          <Link
            to="/?ai_exclude=1"
            onClick={closeAfterNav}
            className={location.search.includes('ai_exclude=1') ? 'sidebar-link-active' : 'sidebar-link'}
          >
            <EyeOff className="w-[15px] h-[15px]" strokeWidth={1.75} />
            对 AI 隐藏
          </Link>
          <Link
            to="/?view=untagged"
            onClick={closeAfterNav}
            className={location.search.includes('untagged') || location.search.includes('view=untagged') ? 'sidebar-link-active' : 'sidebar-link'}
          >
            <Tag className="w-[15px] h-[15px]" strokeWidth={1.75} />
            未加标签
          </Link>
        </div>

        {pinnedViews.length > 0 && (
          <div className="mt-5">
            <SidebarSectionLabel label="固定视图" />
            {pinnedViews.map((v) => (
              <div key={v.id} className="group flex items-center gap-1">
                <Link
                  to={`/?${canonicalViewQuery(v.query)}`}
                  onClick={closeAfterNav}
                  className={`flex-1 px-2.5 py-1 rounded-md text-[13px] truncate transition-colors ${
                    location.search === `?${canonicalViewQuery(v.query)}`
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
                  <div
                    key={doc.id}
                    className={`group flex items-center gap-0.5 rounded-md transition-colors ${
                      isActive
                        ? 'bg-primary-soft text-primary hover:bg-[rgb(var(--primary)_/_0.16)]'
                        : 'text-sidebar-foreground hover:bg-[var(--primary-softer)] hover:text-sidebar-accent-foreground'
                    }`}
                  >
                    <Link
                      to={`/doc/${doc.id}`}
                      onClick={closeAfterNav}
                      className={`min-w-0 flex-1 flex items-center gap-1.5 px-2.5 py-1 text-[13px] ${
                        isActive ? 'font-medium' : ''
                      }`}
                      title={doc.title}
                    >
                      <span className="truncate">{doc.title || '无标题文档'}</span>
                      {draftIds.has(doc.id) && (
                        <span
                          aria-label="有未保存草稿"
                          title="有未保存草稿"
                          className="w-1.5 h-1.5 rounded-full bg-warn shrink-0"
                        />
                      )}
                    </Link>
                    <DocActionsMenu
                      doc={doc}
                      surface="sidebar"
                      compact
                      onDone={() => refetchRecent()}
                      className="pr-0.5"
                    />
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </nav>

      <div className="border-t border-sidebar-border shrink-0">
        <div className="px-3 pt-2 pb-2.5 flex items-center justify-between gap-2">
          <Tooltip label="设置">
            <Link
              to="/settings"
              onClick={closeAfterNav}
              aria-label="设置"
              className={`w-6 h-6 flex items-center justify-center rounded-md transition-colors ${
                location.pathname.startsWith('/settings')
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-muted/70 hover:text-sidebar-accent-foreground hover:bg-sidebar-accent'
              }`}
            >
              <Settings className="w-3.5 h-3.5" strokeWidth={1.75} />
            </Link>
          </Tooltip>
          {version && (
            <span className="text-[10px] font-mono tabular-nums text-sidebar-muted/55">v{version}</span>
          )}
        </div>
      </div>
    </aside>
  )
}
