/**
 * 实体（Entities）— AI 在写入时自动识别的实体总览
 *
 * 概念 / 人物 / 工具 / 文档四类实体，按提及次数倒序。
 * 顶部搜索（q 参数，300ms 防抖）+ kind 筛选；点击实体展开相关笔记列表，再点跳转文档。
 */

import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, GitMerge, Loader2, Search, Waypoints } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import PageHeader from '../components/PageHeader'
import ConfirmDialog from '../components/ConfirmDialog'
import { EntityMentions } from '../components/EntityPanel'
import {
  ENTITY_KIND_LABEL,
  entityKindLabel,
  type EntitySummary,
} from '../lib/entities'

const KIND_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'person', label: ENTITY_KIND_LABEL.person },
  { id: 'tool', label: ENTITY_KIND_LABEL.tool },
  { id: 'concept', label: ENTITY_KIND_LABEL.concept },
  { id: 'doc', label: ENTITY_KIND_LABEL.doc },
] as const

type KindFilter = (typeof KIND_FILTERS)[number]['id']

/** 近义重复候选（/entities/duplicates） */
interface DuplicateGroup {
  reason: string
  entities: Array<{ id: string; display: string; kind: string; mention_count: number }>
}

export default function EntitiesPage() {
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
            实体
          </h1>
          {!loading && !debouncedQuery && (
            <span className="font-mono text-[11px] text-muted-foreground tabular-nums shrink-0">
              {entities.length}
            </span>
          )}
        </div>
      </PageHeader>

      <div className="w-full max-w-4xl mx-auto px-4 sm:px-8 pt-7 pb-16 space-y-5">
        <p className="text-[13px] text-muted-foreground leading-relaxed px-1">
          AI 在写入时自动识别的概念、人物、工具与文档，按提及次数排序。
        </p>

        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="card animate-pulse p-3.5 h-14" />
            ))}
          </div>
        ) : entities.length === 0 && !debouncedQuery ? (
          <div className="px-3 py-14 flex flex-col items-center text-center">
            <div className="empty-icon-tile">
              <Waypoints className="w-5 h-5" />
            </div>
            <h3 className="text-[15px] font-medium text-foreground mb-1.5">还没有实体</h3>
            <p className="text-[13px] text-muted-foreground mb-5 max-w-[300px] leading-relaxed">
              写入文档后，AI 会自动识别其中的概念、人物与工具，在这里逐步沉淀知识关联。
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
                placeholder="搜索实体…"
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
                  可能重复的实体（合并后旧实体名将作为别名自动路由）
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
                          合并（少→多）
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
                  ? `没有匹配「${debouncedQuery}」的实体`
                  : `暂无「${entityKindLabel(kindFilter)}」类实体`}
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
                            <span className="shrink-0 rounded border border-border/60 bg-muted/40 px-1.5 py-px text-[10.5px] text-muted-foreground">
                              {entityKindLabel(e.kind)}
                            </span>
                          </div>
                          <p className="text-[11.5px] text-muted-foreground mt-0.5 tabular-nums">
                            {e.mention_count} 篇笔记提及
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
        title="确认合并实体？"
        message={
          confirmMerge
            ? (() => {
                const [a, b] = confirmMerge.entities
                if (!a || !b) return ''
                const from = a.mention_count <= b.mention_count ? a : b
                const target = from === a ? b : a
                return `将「${from.display}」(${from.mention_count}) 合并进「${target.display}」(${target.mention_count})。此操作不可撤销：源实体被删除，提及全部改挂到目标，旧实体名将作为别名。`
              })()
            : ''
        }
        confirmLabel="确认合并"
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
