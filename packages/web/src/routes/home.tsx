import { useEffect, useCallback, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Plus, FileText, Clock, Tag, Star } from 'lucide-react'
import i18next from '../i18n'
import { usePagedDocList } from '../hooks/usePagedDocList'
import { useDocChanges } from '../hooks/useDocEvents'
import { useTagCatalog } from '../hooks/useTagCatalog'
import { usePinnedViews } from '../hooks/usePinnedViews'
import DocList from '../components/DocList'
import PageHeader from '../components/PageHeader'
import TagFilter, { TagMatchHint } from '../components/TagFilter'
import { Button, EmptyState, InlineError, Input, ListRowsSkeleton, Tooltip } from '../components/ui'

function viewTitle(params: URLSearchParams): string {
  if (params.get('untagged') === '1' || params.get('view') === 'untagged') return i18next.t('home.viewUntagged')
  const within = params.get('within') || params.get('updated_within') || ''
  if (params.get('view') === 'recent' || within) {
    if (within === '7d') return i18next.t('home.viewRecent7d')
    if (within === '30d') return i18next.t('home.viewRecent30d')
    return i18next.t('home.viewRecent24h')
  }
  if (params.get('created_within')) {
    const v = params.get('created_within')!
    return i18next.t('home.viewCreatedWithin', { v })
  }
  if (params.get('stale_within')) {
    const v = params.get('stale_within')!
    if (v === '30d') return i18next.t('home.viewStale30d')
    if (v === '90d') return i18next.t('home.viewStale90d')
    return i18next.t('home.viewStaleLong')
  }
  if (params.get('ai_exclude') === '1') return i18next.t('home.viewAiExclude')
  if (params.get('status') === 'archived') return i18next.t('home.viewArchived')
  if (params.get('status') === 'inbox') return i18next.t('home.viewInbox')
  const tags = params.get('tags') || params.get('tag')
  if (tags) {
    const parts = tags.split(',').filter(Boolean)
    if (parts.length >= 2) {
      // 交/并改由标题旁 TagMatchHint 表达，避免和 chip 行开关重复
      return i18next.t('home.tagsTitle', { mode: '', tags })
    }
    return i18next.t('home.tagsTitleSimple', { tags })
  }
  return i18next.t('home.allDocs')
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
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const listQuery = useMemo(() => buildListQuery(searchParams), [searchParams])
  const title = useMemo(() => viewTitle(searchParams), [searchParams])
  const { pin, isPinned } = usePinnedViews()
  const [showPinModal, setShowPinModal] = useState(false)
  const [pinName, setPinName] = useState(title)

  const hasFilter = searchParams.get('tags') || searchParams.get('tag') ||
    searchParams.get('status') || searchParams.get('updated_within') ||
    searchParams.get('created_within') || searchParams.get('stale_within') ||
    searchParams.get('ai_exclude') === '1' ||
    searchParams.get('untagged') === '1' || searchParams.get('view') === 'untagged' ||
    searchParams.get('view') === 'recent'

  // 空状态视觉区分：全量 / 标签筛选 / 其它智能视图
  const viewKind: 'all' | 'tag' | 'other' =
    !hasFilter ? 'all' : searchParams.get('tags') || searchParams.get('tag') ? 'tag' : 'other'

  const { docs, loading, error, refetch, hasMore, loadingMore, loadMore } = usePagedDocList(`/docs/list${listQuery}`)
  const { loading: tagsLoading, tags: tagCatalog } = useTagCatalog()
  // 无标签缓存时等 GET /tags 与列表一起出，避免 chip 行插入把列表顶下去
  const waitingTags = tagsLoading && tagCatalog.length === 0
  const showListSkeleton = (loading && docs.length === 0) || waitingTags
  useEffect(() => {
    if (error) console.error(error)
  }, [error])

  const handleRefresh = useCallback(() => { refetch() }, [refetch])
  // 外部 MCP / AI 聊天等任何通道写入文档 → 即时刷新主列表（沿用当前筛选条件）
  useDocChanges(handleRefresh)
  const goNew = useCallback(() => { navigate('/new') }, [navigate])

  return (
    <div className="animate-fade-in">
      <PageHeader innerClassName="flex items-center gap-4">
        <div className="min-w-0 flex items-center gap-2">
          <h1 className="text-md font-medium text-foreground truncate tracking-[-0.005em]">
            {title}
          </h1>
          <TagMatchHint />
          {hasFilter && (
            <Tooltip label={t('home.pinTitle')}>
              <button
                onClick={() => { setPinName(title); setShowPinModal(true) }}
                className="p-1 rounded-md hover:bg-sidebar-accent text-muted-foreground hover:text-foreground transition-colors shrink-0"
                aria-label={t('home.pinTitle')}
              >
                <Star className="w-3.5 h-3.5" strokeWidth={1.75} fill={isPinned(listQuery) ? 'currentColor' : 'none'} />
              </button>
            </Tooltip>
          )}
          {!showListSkeleton && docs.length > 0 && (
            <span className="font-mono text-xs text-muted-foreground/80 tabular-nums shrink-0">
              {docs.length}{hasMore ? '+' : ''}
            </span>
          )}
        </div>
      </PageHeader>

      <div className="w-full max-w-4xl mx-auto px-4 sm:px-8 pt-7 pb-16 space-y-5 animate-fade-in">
        <TagFilter />

        <section className="space-y-3 animate-fade-in">
          {showListSkeleton ? (
            <ListRowsSkeleton rows={5} />
          ) : error && docs.length === 0 ? (
            <InlineError message={error.message} onRetry={handleRefresh} />
          ) : docs.length === 0 ? (
            <HomeEmptyState onCreate={goNew} title={title} kind={viewKind} />
          ) : (
            <>
            {error && (
              <InlineError compact message={error.message} onRetry={handleRefresh} />
            )}
            <DocList docs={docs} onRefresh={handleRefresh} />
            {hasMore && (
              <div className="pt-2 flex justify-center">
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="text-base text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md hover:bg-accent transition-colors disabled:opacity-50"
                >
                  {loadingMore ? t('home.loadingMore') : t('home.loadMore')}
                </button>
              </div>
            )}
            </>
          )}
        </section>
      </div>

      {showPinModal && (
        <div className="fixed inset-0 z-sheet flex items-center justify-center bg-black/30" onClick={() => setShowPinModal(false)}>
          <div className="bg-card border border-border rounded-lg p-5 w-80 shadow-floating space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="text-md font-medium text-foreground">{t('home.pinViewTitle')}</div>
            <Input
              type="text"
              value={pinName}
              onChange={(e) => setPinName(e.target.value)}
              className="rounded-lg py-2"
              placeholder={t('home.pinViewPlaceholder')}
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
              <button onClick={() => setShowPinModal(false)} className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">{t('common.cancel')}</button>
              <button onClick={() => { pin(pinName || title, listQuery); setShowPinModal(false) }} className="px-3 py-1.5 text-sm font-medium bg-foreground text-background rounded-md hover:opacity-90 transition-opacity">{t('home.pin')}</button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

function HomeEmptyState({ onCreate, title, kind }: { onCreate: () => void; title: string; kind: 'all' | 'tag' | 'other' }) {
  const { t } = useTranslation()
  const isAll = kind === 'all'
  return (
    <EmptyState
      icon={isAll ? <FileText className="w-5 h-5" /> : kind === 'tag' ? <Tag className="w-5 h-5" /> : <Clock className="w-5 h-5" />}
      title={isAll ? t('home.emptyAllTitle') : t('home.emptyFilteredTitle', { title })}
      description={isAll ? t('home.emptyAllDesc') : t('home.emptyFilteredDesc')}
      action={(
        <Button type="button" variant="secondary" size="sm" onClick={onCreate} icon={<Plus className="w-3.5 h-3.5" strokeWidth={1.75} />}>
          {t('home.newDoc')}
        </Button>
      )}
    />
  )
}
