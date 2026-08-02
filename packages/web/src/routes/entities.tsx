/**
 * 实体（Entities）— AI 在写入时自动识别的实体总览
 *
 * 概念 / 人物 / 工具 / 文档四类实体，按提及次数倒序。
 * 顶部搜索（q 参数，300ms 防抖）+ kind 筛选；点击实体展开相关笔记列表，再点跳转文档。
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, GitMerge, Loader2, Search, Waypoints } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import PageHeader from '../components/PageHeader'
import { ListRowsSkeleton } from '../components/ui'
import { graphKindColor } from '../lib/graph'
import ConfirmDialog from '../components/ConfirmDialog'
import { EntityMentions } from '../components/EntityPanel'
import { entityKindLabel, type EntitySummary } from '../lib/entities'

function kindFilters(t: (key: string) => string) {
  return [
    { id: 'all', label: t('entities.kindAll') },
    { id: 'person', label: entityKindLabel('person') },
    { id: 'tool', label: entityKindLabel('tool') },
    { id: 'concept', label: entityKindLabel('concept') },
    { id: 'doc', label: entityKindLabel('doc') },
  ] as const
}

type KindFilter = 'all' | 'person' | 'tool' | 'concept' | 'doc'

/** 近义重复候选（/entities/duplicates） */
interface DuplicateGroup {
  reason: string
  entities: Array<{ id: string; display: string; kind: string; mention_count: number }>
}

export default function EntitiesPage() {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  const [merging, setMerging] = useState<string | null>(null)
  const [confirmMerge, setConfirmMerge] = useState<DuplicateGroup | null>(null)

  // 300ms 防抖；空关键词回全量列表
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 300)
    return () => clearTimeout(t)
  }, [query])

  const { data, loading, error, refetch } = useApiQuery(
    () =>
      api.get<{ entities: EntitySummary[] }>(
        '/entities?limit=200' + (debouncedQuery ? `&q=${encodeURIComponent(debouncedQuery)}` : ''),
      ),
    [debouncedQuery],
  )
  const entities = error ? [] : (data?.entities ?? [])
  const searching = query.trim() !== debouncedQuery

  // 近义重复候选（仅总览、无搜索词时显示）
  const { data: dupData, refetch: refetchDuplicates } = useApiQuery(
    () => api.get<{ groups: DuplicateGroup[] }>('/entities/duplicates'),
    [debouncedQuery],
  )
  const duplicates = !debouncedQuery ? (dupData?.groups ?? []) : []

  const doMerge = async (g: DuplicateGroup) => {
    const [a, b] = g.entities
    if (!a || !b) return
    // 合并到提及数多的一方（少→多），保持知识面完整
    const from = a.mention_count <= b.mention_count ? a : b
    const target = from === a ? b : a
    setMerging(from.id)
    try {
      await api.post(`/entities/${from.id}/merge`, { target_id: target.id })
      refetch()
      refetchDuplicates()
    } catch {
      /* 失败静默（可加 toast） */
    } finally {
      setMerging(null)
    }
  }

  const filtered = useMemo(() => {
    if (kindFilter === 'all') return entities
    return entities.filter((e) => e.kind === kindFilter)
  }, [entities, kindFilter])

  const KIND_FILTERS = kindFilters(t)

  const kindCounts = useMemo(() => {
    const counts: Record<string, number> = { all: entities.length }
    for (const e of entities) {
      counts[e.kind] = (counts[e.kind] ?? 0) + 1
    }
    return counts
  }, [entities])

  return (
    <div className="animate-fade-in">
      <PageHeader innerClassName="flex items-center justify-between gap-4">
        <div className="min-w-0 flex items-center gap-2">
          <h1 className="text-[15px] font-medium text-foreground truncate tracking-[-0.005em]">
            {t('entities.pageTitle')}
          </h1>
          {!loading && !debouncedQuery && entities.length > 0 && (
            <span className="font-mono text-[11px] text-muted-foreground tabular-nums shrink-0">
              {entities.length}
            </span>
          )}
        </div>
      </PageHeader>

      <div className="w-full max-w-4xl mx-auto px-4 sm:px-8 pt-7 pb-16 space-y-5">
        <p className="text-[13px] text-muted-foreground leading-relaxed px-1">
          {t('entities.description')}
        </p>

        {loading ? (
          <ListRowsSkeleton rows={4} withIcon={false} />
        ) : entities.length === 0 && !debouncedQuery ? (
          <div className="px-3 py-14 flex flex-col items-center text-center">
            <div className="empty-icon-tile">
              <Waypoints className="w-5 h-5" />
            </div>
            <h3 className="text-[15px] font-medium text-foreground mb-1.5">{t('entities.emptyTitle')}</h3>
            <p className="text-[13px] text-muted-foreground mb-5 max-w-[300px] leading-relaxed">
              {t('entities.emptyDesc')}
            </p>
          </div>
        ) : (
          <>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" strokeWidth={1.75} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('entities.searchPlaceholder')}
                className="w-full rounded-lg border border-border bg-card pl-9 pr-8 py-2 text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/30 focus:border-primary/40"
              />
              {searching && (
                <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 animate-spin text-muted-foreground/60" strokeWidth={1.75} />
              )}
            </div>

            <div className="flex flex-wrap gap-1.5 px-0.5">
              {KIND_FILTERS.map((f) => {
                const count = kindCounts[f.id] ?? 0
                if (f.id !== 'all' && count === 0 && !debouncedQuery) return null
                const active = kindFilter === f.id
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setKindFilter(f.id)}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors ${
                      active
                        ? 'bg-primary-soft text-primary'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/70'
                    }`}
                  >
                    {f.id !== 'all' && (
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: graphKindColor(f.id) }} />
                    )}
                    {f.label}
                    <span className={`tabular-nums text-[10.5px] ${active ? 'text-primary/70' : 'text-muted-foreground/60'}`}>
                      {count}
                    </span>
                  </button>
                )
              })}
            </div>

            {duplicates.length > 0 && (
              <div className="rounded-xl border border-warn/25 bg-warn/5 px-3.5 py-3">
                <div className="flex items-center gap-1.5 text-[12px] font-medium text-foreground mb-2">
                  <GitMerge className="w-3.5 h-3.5 text-warn" strokeWidth={1.75} />
                  {t('entities.duplicatesTitle')}
                </div>
                <div className="flex flex-col gap-2">
                  {duplicates.map((g, i) => {
                    const [a, b] = g.entities
                    if (!a || !b) return null
                    return (
                      <div
                        key={i}
                        className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
                      >
                        <span className="text-[12px] text-muted-foreground tabular-nums min-w-0">
                          <span className="text-foreground">{a.display}</span>
                          <span className="mx-1 text-muted-foreground/50">({a.mention_count})</span>
                          <span className="text-muted-foreground/60">→</span>
                          <span className="ml-1 text-foreground">{b.display}</span>
                          <span className="mx-1 text-muted-foreground/50">({b.mention_count})</span>
                          <span className="hidden sm:inline text-muted-foreground/60"> · {g.reason}</span>
                        </span>
                        <button
                          type="button"
                          disabled={merging === (a.mention_count <= b.mention_count ? a.id : b.id)}
                          onClick={() => setConfirmMerge(g)}
                          className="ml-auto shrink-0 inline-flex items-center gap-1 rounded-md border border-border bg-background hover:bg-accent hover:border-foreground/20 px-2 py-1 text-[11.5px] text-foreground transition-colors disabled:opacity-50"
                        >
                          {merging === (a.mention_count <= b.mention_count ? a.id : b.id) ? (
                            <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.75} />
                          ) : (
                            <GitMerge className="w-3 h-3" strokeWidth={1.75} />
                          )}
                          {t('entities.mergeButton')}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {filtered.length === 0 ? (
              <p className="px-1 py-8 text-center text-[13px] text-muted-foreground">
                {debouncedQuery
                  ? t('entities.noMatch', { query: debouncedQuery })
                  : t('entities.noKind', { kind: entityKindLabel(kindFilter) })}
              </p>
            ) : (
              <div className="grid gap-0.5">
                {filtered.map((e) => {
                  const open = openId === e.id
                  return (
                    <div key={e.id} className="card-interactive px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() => setOpenId(open ? null : e.id)}
                        className="w-full flex items-center gap-3 text-left"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <h3 className="font-medium text-[14px] text-foreground tracking-[-0.005em] truncate">
                              {e.display}
                            </h3>
                            <span className="shrink-0 inline-flex items-center gap-1 rounded border border-border/60 bg-muted/40 px-1.5 py-px text-[10.5px] text-muted-foreground">
                              <span className="w-1.5 h-1.5 rounded-full" style={{ background: graphKindColor(e.kind) }} />
                              {entityKindLabel(e.kind)}
                            </span>
                          </div>
                          <p className="text-[11.5px] text-muted-foreground mt-0.5 tabular-nums">
                            {t('entities.notesMentioned', { n: e.mention_count })}
                          </p>
                          {e.description && (
                            <p className="text-[12px] text-muted-foreground/80 mt-1 line-clamp-1 leading-relaxed">
                              {e.description}
                            </p>
                          )}
                        </div>
                        <ChevronRight
                          className={`w-4 h-4 shrink-0 text-muted-foreground/50 transition-transform ${open ? 'rotate-90' : ''}`}
                          strokeWidth={1.75}
                        />
                      </button>
                      {open && (
                        <div className="mt-2.5 border-t border-border/50 pt-2.5">
                          <EntityMentions entityId={e.id} />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* 合并确认（不可逆：源实体删除、旧名成为别名） */}
      <ConfirmDialog
        open={confirmMerge !== null}
        title={t('entities.confirmMergeTitle')}
        message={
          confirmMerge
            ? (() => {
                const [a, b] = confirmMerge.entities
                if (!a || !b) return ''
                const from = a.mention_count <= b.mention_count ? a : b
                const target = from === a ? b : a
                return t('entities.confirmMergeMessage', {
                  from: from.display,
                  fromCount: from.mention_count,
                  to: target.display,
                  toCount: target.mention_count,
                })
              })()
            : ''
        }
        confirmLabel={t('entities.confirmMergeButton')}
        destructive
        onConfirm={() => {
          if (confirmMerge) void doMerge(confirmMerge)
          setConfirmMerge(null)
        }}
        onCancel={() => setConfirmMerge(null)}
      />
    </div>
  )
}
