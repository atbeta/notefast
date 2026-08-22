/**
 * 实体（Entities）— AI 在写入时自动识别的实体总览
 *
 * 概念 / 人物 / 工具 / 文档四类实体，按提及次数倒序。
 * 顶部搜索（q 参数，300ms 防抖）+ kind 筛选；点击实体展开相关笔记列表，再点跳转文档。
 *
 * 实体准确性由系统自行保持，不做逐对人工合并：
 * - 拼写变体（typo 信号，编辑距离）页面加载时自动合并
 * - 子串包含（substring 信号，可能是上下位而非同义）经人工确认后直接合并实体
 *   （mergeEntities：提及迁移 + 旧名登记为实体别名；不写词典——词典是设置页的人工策展层）
 */

import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { BookMarked, ChevronRight, GitMerge, Loader2, Search, Sparkles, Waypoints } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import { useAiCapabilities } from '../hooks/useAiCapabilities'
import PageHeader from '../components/PageHeader'
import ConfirmDialog from '../components/ConfirmDialog'
import { EmptyState, ListRowsSkeleton, useToast } from '../components/ui'
import { graphKindColor } from '../lib/graph'
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

/** 词典建议候选（/entities/duplicates 的 suggest_groups，signal=substring） */
interface SuggestGroup {
  reason: string
  entities: Array<{ id: string; display: string; kind: string; mention_count: number }>
}

export default function EntitiesPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const navigate = useNavigate()
  const ai = useAiCapabilities()
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  const [autoMerged, setAutoMerged] = useState(0)
  const [adopting, setAdopting] = useState(false)
  const [mergeAllOpen, setMergeAllOpen] = useState(false)
  const [generatingId, setGeneratingId] = useState<string | null>(null)

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

  // 词典建议候选：由加载时的一次 POST auto-merge 响应携带（合并端点合一，
  // 服务端不再为此重复全表近义计算；GET /duplicates 仅保留 API 兼容）
  const [suggests, setSuggests] = useState<SuggestGroup[]>([])

  // 拼写变体自动合并（一次性，页面加载时执行；有副作用故为 POST 而非 GET）
  useEffect(() => {
    if (debouncedQuery) return
    api
      .post<{ merged: number; suggest_groups: SuggestGroup[] }>('/entities/duplicates/auto-merge', {})
      .then((r) => {
        setSuggests(r.suggest_groups ?? [])
        if (r.merged > 0) {
          setAutoMerged(r.merged)
          refetch()
        }
      })
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 直接合并候选组：mention_count 大者存活；旧名由 mergeEntities 登记为实体别名（不写词典） */
  const mergeGroups = async (groups: SuggestGroup[]) => {
    if (groups.length === 0) return
    setAdopting(true)
    let merged = 0
    for (const g of groups) {
      const [a, b] = g.entities
      if (!a || !b) continue
      const target = a.mention_count >= b.mention_count ? a : b
      const from = target === a ? b : a
      try {
        await api.post(`/entities/${from.id}/merge`, { target_id: target.id })
        merged++
      } catch {
        // 单组失败（候选对引用了已被本批前组合并的实体）跳过，其余继续
      }
    }
    setAdopting(false)
    if (merged > 0) {
      toast.success({ title: t('entities.merged', { n: merged }) })
      refetch()
      // 建议由加载时 POST auto-merge 响应携带（无 GET 可重拉）：本地移除已并掉的组
      const done = new Set<string>()
      for (const g of groups) {
        for (const e of g.entities) done.add(e.id)
      }
      setSuggests((prev) => prev.filter((g) => !g.entities.some((e) => done.has(e.id))))
    } else {
      toast.error({ title: t('entities.mergeFailed') })
    }
  }

  /** 「全部合并」确认弹层的方向预览：被并方 → 存活方 */
  const mergePairPreview = useMemo(
    () =>
      suggests
        .map((g) => {
          const [a, b] = g.entities
          if (!a || !b) return ''
          const target = a.mention_count >= b.mention_count ? a : b
          const from = target === a ? b : a
          return `${from.display} → ${target.display}`
        })
        .filter(Boolean)
        .join('；'),
    [suggests],
  )

  /** 手动生成/重新生成 AI 描述（POST describe 清旧值后调 LLM）；成功后刷新列表 */
  const regenerateDescription = async (id: string) => {
    setGeneratingId(id)
    try {
      const r = await api.post<{ regenerated: boolean; description: string | null }>(`/entities/${id}/describe`, {})
      if (r.regenerated) refetch()
      else toast.error({ title: t('graph.describeFailed') })
    } catch {
      toast.error({ title: t('graph.describeFailed') })
    } finally {
      setGeneratingId(null)
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
          <EmptyState
            icon={<Waypoints className="w-5 h-5" />}
            title={t('entities.emptyTitle')}
            description={ai.ready && !ai.chat ? t('entities.emptyNeedChatDesc') : t('entities.emptyDesc')}
            action={ai.ready && !ai.chat ? (
              <Link
                to="/settings/ai"
                className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-primary-foreground hover:bg-primary-hover transition-colors"
              >
                {t('entities.configureChat')}
              </Link>
            ) : undefined}
          />
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

            {autoMerged > 0 && (
              <div className="rounded-xl border border-success/20 bg-success-soft px-3.5 py-2.5 flex items-center gap-2 text-[12px] text-foreground">
                <GitMerge className="w-3.5 h-3.5 text-success" strokeWidth={1.75} />
                {t('entities.autoMerged', { n: autoMerged })}
              </div>
            )}

            {suggests.length > 0 && !debouncedQuery && (
              <div className="rounded-xl border border-warn/25 bg-warn/5 px-3.5 py-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
                    <GitMerge className="w-3.5 h-3.5 text-warn" strokeWidth={1.75} />
                    {t('entities.suggestTitle')}
                  </div>
                  <button
                    type="button"
                    disabled={adopting}
                    onClick={() => setMergeAllOpen(true)}
                    className="shrink-0 inline-flex items-center gap-1 rounded-md border border-border bg-background hover:bg-accent hover:border-foreground/20 px-2 py-1 text-[11.5px] text-foreground transition-colors disabled:opacity-50"
                  >
                    {adopting ? (
                      <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.75} />
                    ) : (
                      <GitMerge className="w-3 h-3" strokeWidth={1.75} />
                    )}
                    {t('entities.mergeAll')}
                  </button>
                </div>
                <div className="flex flex-col gap-2">
                  {suggests.map((g, i) => {
                    const [a, b] = g.entities
                    if (!a || !b) return null
                    // 行内直接呈现合并方向（与 mergeGroups 同一判定）：from 并入 target，target 存活
                    const target = a.mention_count >= b.mention_count ? a : b
                    const from = target === a ? b : a
                    return (
                      <div
                        key={i}
                        className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
                      >
                        <span className="text-[12px] text-muted-foreground tabular-nums min-w-0">
                          <span className="text-foreground">{from.display}</span>
                          <span className="mx-1 text-muted-foreground/50">({from.mention_count})</span>
                          <span className="text-muted-foreground/60">→</span>
                          <span className="ml-1 text-foreground font-medium">{target.display}</span>
                          <span className="mx-1 text-muted-foreground/50">({target.mention_count})</span>
                          <span className="hidden sm:inline text-muted-foreground/60"> · {g.reason}</span>
                        </span>
                        <button
                          type="button"
                          disabled={adopting}
                          onClick={() => void mergeGroups([g])}
                          className="ml-auto shrink-0 inline-flex items-center gap-1 rounded-md border border-border bg-background hover:bg-accent hover:border-foreground/20 px-2 py-1 text-[11.5px] text-foreground transition-colors disabled:opacity-50"
                        >
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
                            <p className="text-[12px] text-muted-foreground/80 mt-1 leading-relaxed flex items-start gap-1.5">
                              {e.description_source === 'dict' && (
                                <span className="shrink-0 inline-flex items-center gap-1 rounded border border-primary/20 bg-primary-soft px-1.5 py-px text-[10px] text-primary font-medium">
                                  {t('graph.dictSource')}
                                </span>
                              )}
                              {e.description_source === 'ai' && (
                                <span className="shrink-0 inline-flex items-center gap-1 rounded border border-border/60 bg-muted/40 px-1.5 py-px text-[10px] text-muted-foreground">
                                  {t('graph.aiSource')}
                                </span>
                              )}
                              <span className="line-clamp-1">{e.description}</span>
                            </p>
                          )}
                        </div>
                        <ChevronRight
                          className={`w-4 h-4 shrink-0 text-muted-foreground/50 transition-transform ${open ? 'rotate-90' : ''}`}
                          strokeWidth={1.75}
                        />
                      </button>
                      {open && (
                        <div className="mt-2.5 border-t border-border/50 pt-2.5 space-y-2">
                          <div className="flex items-center gap-2">
                            {e.description_source !== 'dict' && (
                              <button
                                type="button"
                                onClick={() => void regenerateDescription(e.id)}
                                disabled={generatingId === e.id}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border/70 bg-background text-[11.5px] text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors disabled:opacity-50"
                              >
                                {generatingId === e.id ? (
                                  <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.75} />
                                ) : (
                                  <Sparkles className="w-3 h-3" strokeWidth={1.75} />
                                )}
                                {e.description ? t('graph.regenerateDescription') : t('graph.generateDescription')}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => navigate('/settings/termdict')}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border/70 bg-background text-[11.5px] text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
                            >
                              <BookMarked className="w-3 h-3" strokeWidth={1.75} />
                              {t('graph.openInDict')}
                            </button>
                          </div>
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

      <ConfirmDialog
        open={mergeAllOpen}
        title={t('entities.mergeAllTitle')}
        message={t('entities.mergeAllMessage', { n: suggests.length, pairs: mergePairPreview })}
        confirmLabel={t('entities.mergeAll')}
        onConfirm={() => {
          setMergeAllOpen(false)
          void mergeGroups(suggests)
        }}
        onCancel={() => setMergeAllOpen(false)}
      />
    </div>
  )
}
