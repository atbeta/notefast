import { useCallback, useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
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
  Trash2,
  Settings,
  Tag,
  Star,
  X,
  Clock,
  Hourglass,
  EyeOff,
  Waypoints,
  Network,
  ChevronDown,
  Images,
} from 'lucide-react'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import { useDocChanges } from '../hooks/useDocEvents'
import { usePinnedViews, canonicalViewQuery, type PinnedView } from '../hooks/usePinnedViews'
import { useScrollFade } from '../hooks/useScrollFade'
import { DRAFT_CHANGED_EVENT, hasDraftSync } from '../hooks/useEditorDraft'
import {
  getRecentVisitIds,
  orderDocsByVisits,
  pruneVisitsNotIn,
  subscribeRecentVisits,
} from '../lib/recentVisits'
import type { DocSummary } from '@notefast/core'
import DocActionsMenu from './DocActionsMenu'
import { Tooltip, ShortcutKeys, shortcutLabel } from './ui'

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
  onOpenPalette: () => void
  onNavigate?: () => void
}

/** GET /docs/counts 返回的侧栏徽章计数（inbox/trash 是队列，untagged/ai_exclude 是债务与审计） */
interface SidebarCounts {
  inbox: number
  archived: number
  trash: number
  untagged: number
  ai_exclude: number
}

const EMPTY_COUNTS: SidebarCounts = { inbox: 0, archived: 0, trash: 0, untagged: 0, ai_exclude: 0 }

/** 计数徽章统一样式（收集箱 / 回收站 / 智能视图共用） */
const COUNT_BADGE_CLS =
  'ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full text-[10px] font-medium bg-sidebar-accent text-sidebar-muted tabular-nums'

function formatCount(n: number): string {
  return n > 99 ? '99+' : String(n)
}

const RECENT_PREVIEW = 6
const RECENT_MAX = 15

/** 侧栏折叠分组状态（localStorage 记忆） */
function useSidebarSectionOpen(key: string, defaultOpen = true) {
  const storageKey = `nf_sidebar_section_${key}`
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(storageKey)
      if (v === '0') return false
      if (v === '1') return true
    } catch { /* ignore */ }
    return defaultOpen
  })
  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev
      try { localStorage.setItem(storageKey, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }, [storageKey])
  return [open, toggle] as const
}

/**
 * Sidebar section 分组标签
 *
 * Notion 式纯文字 micro-label；可折叠时带 chevron，状态记忆在 localStorage。
 */
function SidebarSectionLabel({
  label,
  collapsible,
  open,
  onToggle,
}: {
  label: string
  collapsible?: boolean
  open?: boolean
  onToggle?: () => void
}) {
  if (collapsible && onToggle) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-1 px-2.5 mb-1 select-none text-left group"
        aria-expanded={open}
      >
        <span className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-sidebar-muted/70 group-hover:text-sidebar-muted transition-colors">
          {label}
        </span>
        <ChevronDown
          className={`w-3 h-3 text-sidebar-muted/50 transition-transform ${open ? '' : '-rotate-90'}`}
          strokeWidth={2}
        />
      </button>
    )
  }
  return (
    <div className="px-2.5 mb-1 select-none">
      <span className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-sidebar-muted/70">
        {label}
      </span>
    </div>
  )
}

/** 固定视图行：双击重命名；hooks 必须在独立组件内，不可放在 Sidebar 的 map 回调里 */
function PinnedViewItem({
  view,
  active,
  onNavigate,
  onRename,
  onUnpin,
}: {
  view: PinnedView
  active: boolean
  onNavigate?: () => void
  onRename: (id: string, name: string) => void
  onUnpin: (id: string) => void
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(view.name)

  const handleRename = () => {
    if (editName.trim() && editName.trim() !== view.name) {
      onRename(view.id, editName.trim())
    }
    setEditing(false)
  }

  return (
    <div className="group flex items-center gap-1">
      <Link
        to={`/?${canonicalViewQuery(view.query)}`}
        onClick={onNavigate}
        className={`flex-1 px-2.5 py-1 rounded-md text-[13px] truncate transition-colors ${
          active
            ? 'bg-primary-soft text-primary font-medium'
            : 'text-sidebar-foreground hover:bg-[var(--primary-softer)] hover:text-sidebar-accent-foreground'
        }`}
        title={view.name}
        onDoubleClick={(e) => {
          e.preventDefault()
          setEditing(true)
          setEditName(view.name)
        }}
      >
        {editing ? (
          <input
            autoFocus
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename()
              if (e.key === 'Escape') setEditing(false)
            }}
            onClick={(e) => e.preventDefault()}
            className="w-full text-[13px] bg-transparent border-b border-border outline-none"
          />
        ) : (
          <span className="flex items-center gap-1.5">
            <Star className="w-[11px] h-[11px] shrink-0" strokeWidth={2} />
            {view.name}
          </span>
        )}
      </Link>
      <Tooltip label={t('sidebar.unpin')}>
        <button
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onUnpin(view.id)
          }}
          className="p-0.5 rounded opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 transition-all shrink-0"
          aria-label={t('sidebar.unpin')}
        >
          <X className="w-3 h-3" strokeWidth={2} />
        </button>
      </Tooltip>
    </div>
  )
}

export default function Sidebar({
  collapsed,
  onToggle,
  onOpenPalette,
  onNavigate,
}: SidebarProps) {
  const { t } = useTranslation()
  const location = useLocation()
  const [counts, setCounts] = useState<SidebarCounts>(EMPTY_COUNTS)
  const [recentExpanded, setRecentExpanded] = useState(false)
  const [notesOpen, toggleNotes] = useSidebarSectionOpen('notes', true)
  const [relationsOpen, toggleRelations] = useSidebarSectionOpen('relations', false)
  const [smartOpen, toggleSmart] = useSidebarSectionOpen('smart', true)
  const [pinnedOpen, togglePinned] = useSidebarSectionOpen('pinned', true)
  /**
   * 最近访问：按本机打开足迹排序（localStorage），与首页「最近更新」分开。
   * 默认展开——现在有独立价值；折叠态不发列表请求。
   */
  const [recentOpen, toggleRecent] = useSidebarSectionOpen('recentVisited', true)
  const [visitIds, setVisitIds] = useState(() => getRecentVisitIds())
  useEffect(() => subscribeRecentVisits(() => setVisitIds(getRecentVisitIds())), [])

  const { views: pinnedViews, unpin, rename } = usePinnedViews()
  const navFadeRef = useScrollFade<HTMLElement>()

  /** 实例版本号（/api/v1/version），加载完成前不渲染版本位；失败静默 */
  const { data: versionInfo } = useApiQuery(() => api.get<{ version: string }>('/version'), [])
  const version = versionInfo?.version ?? null

  /**
   * 最近访问：折叠态不展示也不发请求；展开时拉 status=all（含收集箱/归档，
   * 你刚打开过的仍能找到），再按足迹序裁剪。失败静默保留旧数据。
   */
  const { data: docList, refetch: refetchRecent } = useApiQuery(
    () => (collapsed || !recentOpen ? new Promise<DocSummary[]>(() => {}) : api.get<DocSummary[]>('/docs/list?status=all')),
    [collapsed, recentOpen, location.pathname],
  )

  // 列表回来后清掉足迹里已不存在的 id（软删 / 换库残留）
  useEffect(() => {
    if (!docList) return
    pruneVisitsNotIn(new Set(docList.map((d) => d.id)))
  }, [docList])

  const allRecent = orderDocsByVisits(docList ?? [], visitIds).slice(0, RECENT_MAX)
  const recentDocs = recentExpanded ? allRecent : allRecent.slice(0, RECENT_PREVIEW)
  const recentHasMore = allRecent.length > RECENT_PREVIEW
  const recentEmpty = recentOpen && visitIds.length === 0
  const recentGone = recentOpen && visitIds.length > 0 && Boolean(docList) && allRecent.length === 0

  // 草稿圆点：逐条同步探测 + 订阅草稿变更事件（编辑器防抖暂存后实时出现/消失）
  const [draftIds, setDraftIds] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const compute = () => {
      const ids = new Set<string>()
      for (const d of allRecent) {
        if (hasDraftSync(d.id)) ids.add(d.id)
      }
      // 内容相同就复用旧 Set——allRecent 每次渲染都是新数组 identity，effect 会
      // 随之反复触发，若无条件 setState 新 identity 将构成「渲染→effect→渲染」死循环
      setDraftIds((prev) =>
        prev.size === ids.size && [...ids].every((x) => prev.has(x)) ? prev : ids,
      )
    }
    compute()
    window.addEventListener(DRAFT_CHANGED_EVENT, compute)
    return () => window.removeEventListener(DRAFT_CHANGED_EVENT, compute)
  }, [allRecent])

  // 侧栏徽章计数（收集箱/回收站/智能视图）：一次 /docs/counts，SSE 变更即时刷新 + 15s 兜底轮询
  const refreshCounts = useCallback(() => {
    api.get<SidebarCounts>('/docs/counts')
      .then(setCounts)
      .catch(() => {})
  }, [])

  // 外部 MCP / AI 聊天等任何通道写入文档 → 即时刷新最近列表（服务端已聚合去抖）
  useDocChanges(
    useCallback(() => {
      if (!collapsed) {
        refetchRecent()
        refreshCounts()
      }
    }, [collapsed, refetchRecent, refreshCounts]),
  )

  useEffect(() => {
    refreshCounts()
    const t = setInterval(refreshCounts, 15_000)
    return () => clearInterval(t)
  }, [location.pathname, refreshCounts])

  const closeAfterNav = useCallback(() => {
    onNavigate?.()
  }, [onNavigate])

  if (collapsed) {
    return (
      <aside className="w-14 flex flex-col items-center py-3 shrink-0 h-full relative bg-sidebar border-r border-border/50">
        <div
          data-drag-region
          className="h-[calc(3.5rem+var(--shell-top-inset,0px))] pt-[var(--shell-top-inset,0px)] w-full flex items-center justify-center border-b border-border/50 shrink-0 absolute top-0 left-0"
        >
          <Tooltip label={t('sidebar.expandSidebar')}>
            <button onClick={onToggle} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-sidebar-accent text-sidebar-muted hover:text-sidebar-accent-foreground transition-colors group">
              <PanelLeft className="w-4 h-4" strokeWidth={1.75} />
            </button>
          </Tooltip>
        </div>
        <div className="mt-[calc(3.5rem+var(--shell-top-inset,0px))] w-full flex-1 flex flex-col items-center pt-4 gap-1">
          <Tooltip label={t('sidebar.docs')}>
            <Link to="/" className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-sidebar-accent text-sidebar-muted hover:text-primary transition-colors">
              <FileText className="w-4 h-4" strokeWidth={1.75} />
            </Link>
          </Tooltip>
          <Tooltip label={t('sidebar.resources')}>
            <Link
              to="/resources"
              className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors ${
                location.pathname.startsWith('/resources')
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
              }`}
            >
              <Images className="w-4 h-4" strokeWidth={1.75} />
            </Link>
          </Tooltip>
          <div className="flex-1" />
          <Tooltip label={t('sidebar.settings')}>
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
      <div
        data-drag-region
        className="h-[calc(3.5rem+var(--shell-top-inset,0px))] pt-[var(--shell-top-inset,0px)] flex items-center justify-between px-3 border-b border-border/50 shrink-0"
      >
        <div className="flex items-center gap-2">
          <Link to="/" onClick={closeAfterNav} className="flex items-center gap-2 font-semibold text-[15px] text-foreground hover:text-foreground/80 transition-colors tracking-[-0.01em]">
            <span className="w-7 h-7 grid place-items-center rounded-md bg-foreground text-background">
              <BookOpen className="w-3.5 h-3.5" strokeWidth={2.25} />
            </span>
            NoteFast
          </Link>
          <Tooltip label="NoteFast v0.1">
            <span className="text-[10px] font-medium uppercase tracking-[0.06em] px-1.5 py-[1px] rounded border border-border/60 text-muted-foreground/80 bg-muted/40">
              Beta
            </span>
          </Tooltip>
        </div>
        <div className="flex items-center gap-0.5">
          <Tooltip label={t('sidebar.collapseSidebar')}>
            <button onClick={onToggle} className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-sidebar-accent text-sidebar-muted hover:text-sidebar-accent-foreground transition-colors group">
              <PanelLeftClose className="w-4 h-4" strokeWidth={1.75} />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="px-3 pt-3 pb-2 shrink-0">
        <button
          type="button"
          onClick={onOpenPalette}
          className="group w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-border bg-background text-muted-foreground hover:text-foreground hover:border-foreground/15 transition-colors text-[13px]"
          aria-label={t('sidebar.openPalette')}
        >
          <Search className="w-3.5 h-3.5" strokeWidth={1.75} />
          {/* 无文案：英文 Search documents… 在 w-60 会换行；图标 + ⌘K + aria-label 已够 */}
          <span className="flex-1 min-w-0" aria-hidden="true" />
          <ShortcutKeys keys={['mod', 'K']} />
        </button>
      </div>

      <nav ref={navFadeRef} className="scroll-fade px-2 pt-2 pb-1 flex-1 overflow-y-auto">
        <SidebarSectionLabel label={t('sidebar.sectionNotes')} collapsible open={notesOpen} onToggle={toggleNotes} />
        {notesOpen && (
          <>
            <Link to="/" onClick={closeAfterNav} className={location.pathname === '/' && !location.search ? 'sidebar-link-active' : 'sidebar-link'}>
              <LayoutGrid className="w-[15px] h-[15px]" strokeWidth={1.75} />
              {t('sidebar.allDocs')}
            </Link>
            <Tooltip className="w-full" label={t('sidebar.newDocTitle', { shortcut: shortcutLabel(['mod', 'N']) })}>
              <Link to="/new" onClick={closeAfterNav} className={`w-full ${location.pathname === '/new' ? 'sidebar-link-active' : 'sidebar-link'}`}>
                <Plus className="w-[15px] h-[15px]" strokeWidth={1.75} />
                {t('sidebar.newDoc')}
              </Link>
            </Tooltip>
            <Link to="/inbox" onClick={closeAfterNav} className={location.pathname === '/inbox' ? 'sidebar-link-active' : 'sidebar-link'}>
              <Inbox className="w-[15px] h-[15px]" strokeWidth={1.75} />
              <span className="flex-1">{t('sidebar.inbox')}</span>
              {counts.inbox > 0 && (
                <span className={COUNT_BADGE_CLS}>{formatCount(counts.inbox)}</span>
              )}
            </Link>
            <Link to="/archived" onClick={closeAfterNav} className={location.pathname === '/archived' ? 'sidebar-link-active' : 'sidebar-link'}>
              <Archive className="w-[15px] h-[15px]" strokeWidth={1.75} />
              <span className="flex-1">{t('sidebar.archived')}</span>
            </Link>
            <Link to="/trash" onClick={closeAfterNav} className={location.pathname === '/trash' ? 'sidebar-link-active' : 'sidebar-link'}>
              <Trash2 className="w-[15px] h-[15px]" strokeWidth={1.75} />
              <span className="flex-1">{t('sidebar.trash')}</span>
              {counts.trash > 0 && (
                <span className={COUNT_BADGE_CLS}>{formatCount(counts.trash)}</span>
              )}
            </Link>
          </>
        )}

        <div className="mt-5">
          <SidebarSectionLabel label={t('sidebar.sectionResources')} />
          <Link to="/resources" onClick={closeAfterNav} className={location.pathname.startsWith('/resources') ? 'sidebar-link-active' : 'sidebar-link'}>
            <Images className="w-[15px] h-[15px]" strokeWidth={1.75} />
            <span className="flex-1">{t('sidebar.resources')}</span>
          </Link>
        </div>

        <div className="mt-5">
          <SidebarSectionLabel label={t('sidebar.sectionRelations')} collapsible open={relationsOpen} onToggle={toggleRelations} />
          {relationsOpen && (
            <>
              <Link to="/entities" onClick={closeAfterNav} className={location.pathname === '/entities' ? 'sidebar-link-active' : 'sidebar-link'}>
                <Waypoints className="w-[15px] h-[15px]" strokeWidth={1.75} />
                <span className="flex-1">{t('sidebar.entities')}</span>
              </Link>
              <Link to="/graph" onClick={closeAfterNav} className={location.pathname === '/graph' ? 'sidebar-link-active' : 'sidebar-link'}>
                <Network className="w-[15px] h-[15px]" strokeWidth={1.75} />
                <span className="flex-1">{t('sidebar.graph')}</span>
              </Link>
            </>
          )}
        </div>

        <div className="mt-5">
          <SidebarSectionLabel label={t('sidebar.smartViews')} collapsible open={smartOpen} onToggle={toggleSmart} />
          {smartOpen && (
            <>
              <Link
                to="/?updated_within=7d"
                onClick={closeAfterNav}
                className={location.search.includes('updated_within=7d') ? 'sidebar-link-active' : 'sidebar-link'}
              >
                <Clock className="w-[15px] h-[15px]" strokeWidth={1.75} />
                {t('sidebar.recent7Days')}
              </Link>
              <Link
                to="/?stale_within=90d"
                onClick={closeAfterNav}
                className={location.search.includes('stale_within=90d') ? 'sidebar-link-active' : 'sidebar-link'}
              >
                <Hourglass className="w-[15px] h-[15px]" strokeWidth={1.75} />
                {t('sidebar.stale90Days')}
              </Link>
              <Link
                to="/?ai_exclude=1"
                onClick={closeAfterNav}
                className={location.search.includes('ai_exclude=1') ? 'sidebar-link-active' : 'sidebar-link'}
              >
                <EyeOff className="w-[15px] h-[15px]" strokeWidth={1.75} />
                <span className="flex-1">{t('sidebar.aiHidden')}</span>
                {counts.ai_exclude > 0 && (
                  <span className={COUNT_BADGE_CLS}>{formatCount(counts.ai_exclude)}</span>
                )}
              </Link>
              <Link
                to="/?view=untagged"
                onClick={closeAfterNav}
                className={location.search.includes('untagged') || location.search.includes('view=untagged') ? 'sidebar-link-active' : 'sidebar-link'}
              >
                <Tag className="w-[15px] h-[15px]" strokeWidth={1.75} />
                <span className="flex-1">{t('sidebar.untagged')}</span>
                {counts.untagged > 0 && (
                  <span className={COUNT_BADGE_CLS}>{formatCount(counts.untagged)}</span>
                )}
              </Link>
            </>
          )}
        </div>

        {pinnedViews.length > 0 && (
          <div className="mt-5">
            <SidebarSectionLabel label={t('sidebar.pinnedViews')} collapsible open={pinnedOpen} onToggle={togglePinned} />
            {pinnedOpen && pinnedViews.map((v) => (
              <PinnedViewItem
                key={v.id}
                view={v}
                active={location.search === `?${canonicalViewQuery(v.query)}`}
                onNavigate={closeAfterNav}
                onRename={rename}
                onUnpin={unpin}
              />
            ))}
          </div>
        )}

        <div className="mt-5">
            <SidebarSectionLabel
              label={t('sidebar.recentVisited')}
              collapsible
              open={recentOpen}
              onToggle={toggleRecent}
            />
            {recentOpen && recentEmpty && (
              <p className="px-2.5 py-1.5 text-[11.5px] text-sidebar-muted leading-relaxed">
                {t('sidebar.recentVisitedEmpty')}
              </p>
            )}
            {recentOpen && recentGone && (
              <p className="px-2.5 py-1.5 text-[11.5px] text-sidebar-muted leading-relaxed">
                {t('sidebar.recentVisitedEmpty')}
              </p>
            )}
            {recentOpen && allRecent.length > 0 && (
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
                      <span className="truncate">{doc.title || t('sidebar.untitled')}</span>
                      {draftIds.has(doc.id) && (
                        <Tooltip label={t('sidebar.hasDraft')}>
                          <span
                            aria-label={t('sidebar.hasDraft')}
                            className="w-1.5 h-1.5 rounded-full bg-warn shrink-0"
                          />
                        </Tooltip>
                      )}
                    </Link>
                    <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0 pr-0.5">
                      <DocActionsMenu
                        doc={doc}
                        surface="sidebar"
                        compact
                        onDone={() => refetchRecent()}
                      />
                    </div>
                  </div>
                )
              })}
              {recentHasMore && (
                <button
                  type="button"
                  onClick={() => setRecentExpanded((v) => !v)}
                  className="px-2.5 py-1 text-[11.5px] text-sidebar-muted hover:text-sidebar-accent-foreground text-left transition-colors"
                >
                  {recentExpanded ? t('sidebar.collapse') : t('sidebar.expandAll', { n: allRecent.length })}
                </button>
              )}
            </div>
            )}
        </div>
      </nav>

      <div className="border-t border-sidebar-border shrink-0">
        <div className="px-3 pt-2 pb-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Tooltip label={t('sidebar.settings')}>
              <Link
                to="/settings"
                onClick={closeAfterNav}
                aria-label={t('sidebar.settings')}
                className={`w-6 h-6 flex items-center justify-center rounded-md transition-colors ${
                  location.pathname.startsWith('/settings')
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-muted/70 hover:text-sidebar-accent-foreground hover:bg-sidebar-accent'
                }`}
              >
                <Settings className="w-3.5 h-3.5" strokeWidth={1.75} />
              </Link>
            </Tooltip>
          </div>
          {version && (
            <span className="text-[10px] font-mono tabular-nums text-sidebar-muted/55">v{version}</span>
          )}
        </div>
      </div>
    </aside>
  )
}
