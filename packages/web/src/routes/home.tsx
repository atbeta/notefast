import { useEffect, useCallback, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, FileText, Clock, Tag, Star } from 'lucide-react'
import type { DocSummary } from '@notefast/core'
import { parseTagMatchMode } from '@notefast/core'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import { useDocChanges } from '../hooks/useDocEvents'
import { usePinnedViews } from '../hooks/usePinnedViews'
import DocList from '../components/DocList'
import PageHeader from '../components/PageHeader'
import TagFilter from '../components/TagFilter'

function viewTitle(params: URLSearchParams): string {
  if (params.get('untagged') === '1' || params.get('view') === 'untagged') return '未加标签'
  const within = params.get('within') || params.get('updated_within') || ''
  if (params.get('view') === 'recent' || within) {
    if (within === '7d') return '最近 7 天更新'
    if (within === '30d') return '最近 30 天更新'
    return '最近 24 小时更新'
  }
  if (params.get('created_within')) {
    const v = params.get('created_within')!
    return `新建于 ${v} 内`
  }
  if (params.get('stale_within')) {
    const v = params.get('stale_within')!
    if (v === '30d') return '30 天未更新'
    if (v === '90d') return '90 天未更新'
    return '许久未更新'
  }
  if (params.get('ai_exclude') === '1') return '对 AI 隐藏'
  if (params.get('status') === 'archived') return '归档'
  if (params.get('status') === 'inbox') return '收集箱'
  const tags = params.get('tags') || params.get('tag')
  if (tags) {
    const parts = tags.split(',').filter(Boolean)
    if (parts.length >= 2) {
      const mode = parseTagMatchMode(params.get('tag_match'))
      const suffix = mode === 'any' ? '（任一）' : '（同时）'
      return `标签${suffix}：${tags}`
    }
    return `标签：${tags}`
  }
  return '所有文档'
}

function buildListQuery(params: URLSearchParams): string {
  const q = new URLSearchParams()
  const tags = params.get('tags') || ''
  const tag = params.get('tag') || ''
  if (tags) q.set('tags', tags)
  else if (tag) q.set('tag', tag)

  const tagMatch = params.get('tag_match')
  if (tagMatch === 'any') q.set('tag_match', 'any')

  if (params.get('untagged') === '1' || params.get('view') === 'untagged') {
    q.set('untagged', '1')
    q.delete('tags')
    q.delete('tag')
  }

  const within = params.get('within') || params.get('updated_within') || ''
  if (within === '24h' || within === '7d' || within === '30d') q.set('updated_within', within)
  else if (params.get('view') === 'recent') q.set('updated_within', '24h')

  const created = params.get('created_within') || ''
  if (created === '24h' || created === '7d' || created === '30d') q.set('created_within', created)

  const stale = params.get('stale_within') || ''
  if (stale === '30d' || stale === '90d') q.set('stale_within', stale)

  if (params.get('ai_exclude') === '1') q.set('ai_exclude', '1')

  // status 透传（?status=archived / inbox 直达对应视图）
  const status = params.get('status') || ''
  if (status === 'archived' || status === 'inbox' || status === 'all') q.set('status', status)

  const s = q.toString()
  return s ? `?${s}` : ''
}

export default function HomePage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const listQuery = useMemo(() => buildListQuery(searchParams), [searchParams])
  const title = useMemo(() => viewTitle(searchParams), [searchParams])
  const { pin, isPinned } = usePinnedViews()
  const [showPinModal, setShowPinModal] = useState(false)
  const [pinName, setPinName] = useState(title)
  const [showWelcome, setShowWelcome] = useState(false)

  useEffect(() => {
    if (localStorage.getItem('nf_first_run_done')) return
    api.get<{ first_run: boolean }>('/status').then((r) => {
      if ((r as any).body?.first_run) setShowWelcome(true)
    }).catch(() => {})
  }, [])

  const hasFilter = searchParams.get('tags') || searchParams.get('tag') ||
    searchParams.get('status') || searchParams.get('updated_within') ||
    searchParams.get('created_within') || searchParams.get('stale_within') ||
    searchParams.get('ai_exclude') === '1' ||
    searchParams.get('untagged') === '1' || searchParams.get('view') === 'untagged' ||
    searchParams.get('view') === 'recent'

  const { data, loading, error, refetch } = useApiQuery(
    () => api.get<DocSummary[]>(`/docs/list${listQuery}`),
    [listQuery],
  )
  const docs = data ?? []
  // 原 .catch(console.error) 语义：失败只打日志，列表保留旧数据
  useEffect(() => {
    if (error) console.error(error)
  }, [error])

  const handleRefresh = useCallback(() => { refetch() }, [refetch])
  // 外部 MCP / AI 聊天等任何通道写入文档 → 即时刷新主列表（沿用当前筛选条件）
  useDocChanges(handleRefresh)
  const goNew = useCallback(() => { navigate('/new') }, [navigate])

  return (
    <div className="animate-fade-in">
      <PageHeader innerClassName="flex items-center justify-between gap-4">
        <div className="min-w-0 flex items-center gap-2">
          <h1 className="text-[15px] font-medium text-foreground truncate tracking-[-0.005em]">
            {title}
          </h1>
          {hasFilter && (
            <button
              onClick={() => { setPinName(title); setShowPinModal(true) }}
              className="p-1 rounded-md hover:bg-sidebar-accent text-muted-foreground hover:text-foreground transition-colors shrink-0"
              title="固定到侧边栏"
            >
              <Star className="w-3.5 h-3.5" strokeWidth={1.75} fill={isPinned(listQuery) ? 'currentColor' : 'none'} />
            </button>
          )}
          {!loading && (
            <span className="font-mono text-[11px] text-muted-foreground/80 tabular-nums shrink-0">
              {docs.length}
            </span>
          )}
        </div>
        <button onClick={goNew} className="btn-primary-custom shrink-0">
          <Plus className="w-3.5 h-3.5" strokeWidth={2.25} />
          新建文档
        </button>
      </PageHeader>

      <div className="w-full max-w-4xl mx-auto px-8 pt-7 pb-16 space-y-5 animate-fade-in">
        <TagFilter />

        <section className="space-y-3 animate-fade-in">
          {loading ? (
            <div className="space-y-0.5">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="animate-pulse px-3 py-2 flex items-center gap-3">
                  <div className="w-7 h-7 rounded-md bg-secondary shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3.5 bg-secondary rounded w-1/3" />
                    <div className="h-2.5 bg-secondary rounded w-1/5" />
                  </div>
                  <div className="h-2.5 bg-secondary rounded w-12 shrink-0" />
                </div>
              ))}
            </div>
          ) : docs.length === 0 ? (
            <EmptyState onCreate={goNew} title={title} />
          ) : (
            <DocList docs={docs} onRefresh={handleRefresh} />
          )}
        </section>
      </div>

      {showPinModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShowPinModal(false)}>
          <div className="bg-card border border-border rounded-lg p-5 w-80 shadow-xl space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="text-[14px] font-medium text-foreground">固定视图</div>
            <input
              type="text"
              value={pinName}
              onChange={(e) => setPinName(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-foreground/20"
              placeholder="视图名称"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  pin(pinName || title, listQuery)
                  setShowPinModal(false)
                }
                if (e.key === 'Escape') setShowPinModal(false)
              }}
            />
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setShowPinModal(false)} className="px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors">取消</button>
              <button onClick={() => { pin(pinName || title, listQuery); setShowPinModal(false) }} className="px-3 py-1.5 text-[12px] font-medium bg-foreground text-background rounded-md hover:opacity-90 transition-opacity">固定</button>
            </div>
          </div>
        </div>
      )}

      {showWelcome && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-card border border-border rounded-lg p-8 w-[420px] shadow-2xl space-y-5 text-center">
            <h2 className="text-[22px] font-bold text-foreground tracking-[-0.02em]">欢迎使用 NoteFast</h2>
            <p className="text-[14px] text-muted-foreground leading-relaxed">
              基础功能开箱即用：标签、文档、智能视图、全文搜索。
              <br />
              配置 AI 后可解锁语义搜索、自动链接与 AI 对话。
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => {
                  localStorage.setItem('nf_first_run_done', '1')
                  setShowWelcome(false)
                  navigate('/settings/ai')
                }}
                className="px-4 py-2 text-[13px] font-medium bg-foreground text-background rounded-lg hover:opacity-90 transition-opacity"
              >
                配置 AI
              </button>
              <button
                onClick={() => {
                  localStorage.setItem('nf_first_run_done', '1')
                  setShowWelcome(false)
                  navigate('/settings')
                }}
                className="px-4 py-2 text-[13px] font-medium border border-border rounded-lg hover:bg-muted transition-colors"
              >
                创建 API Token
              </button>
              <button
                onClick={() => {
                  localStorage.setItem('nf_first_run_done', '1')
                  setShowWelcome(false)
                }}
                className="px-4 py-2 text-[13px] text-muted-foreground hover:text-foreground transition-colors"
              >
                先看看
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

function EmptyState({ onCreate, title }: { onCreate: () => void; title: string }) {
  const isAll = title === '所有文档'
  return (
    <div className="px-3 py-12 flex flex-col items-center text-center">
      <div className="empty-icon-tile">
        {isAll ? <FileText className="w-5 h-5" /> : title.includes('标签') ? <Tag className="w-5 h-5" /> : <Clock className="w-5 h-5" />}
      </div>
      <h3 className="text-[15px] font-medium text-foreground mb-1.5 tracking-[-0.005em]">
        {isAll ? '这里还没有文档' : `「${title}」暂无文档`}
      </h3>
      <p className="text-[13px] text-muted-foreground mb-5 max-w-[280px] leading-relaxed">
        {isAll
          ? '点一下下方按钮，新建你的第一篇 Markdown 文档。也可以把现有 .md 文件拖进编辑器直接导入。'
          : '试试切换其他智能视图，或新建一篇文档。'}
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-card hover:border-foreground/30 hover:text-foreground text-foreground text-sm font-medium transition-colors"
      >
        <Plus className="w-3.5 h-3.5" strokeWidth={1.75} />
        新建文档
      </button>
    </div>
  )
}
