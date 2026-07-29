/**
 * 实体（Entities）— AI 在写入时自动识别的实体总览
 *
 * 概念 / 人物 / 工具 / 文档四类实体，按提及次数倒序。
 * 顶部搜索（q 参数，300ms 防抖）；点击实体展开相关笔记列表，再点跳转文档。
 */

import { useEffect, useState } from 'react'
import { ChevronRight, Loader2, Search, Waypoints } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import PageHeader from '../components/PageHeader'
import { EntityMentions } from '../components/EntityPanel'
import { entityKindLabel, type EntitySummary } from '../lib/entities'

export default function EntitiesPage() {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)

  // 300ms 防抖；空关键词回全量列表
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 300)
    return () => clearTimeout(t)
  }, [query])

  const { data, loading, error } = useApiQuery(
    () =>
      api.get<{ entities: EntitySummary[] }>(
        '/entities?limit=200' + (debouncedQuery ? `&q=${encodeURIComponent(debouncedQuery)}` : ''),
      ),
    [debouncedQuery],
  )
  const entities = error ? [] : (data?.entities ?? [])
  const searching = query.trim() !== debouncedQuery

  return (
    <div className="animate-fade-in">
      <PageHeader innerClassName="flex items-center justify-between gap-4">
        <div className="min-w-0 flex items-center gap-2">
          <h1 className="text-[15px] font-medium text-foreground truncate tracking-[-0.005em]">
            实体
          </h1>
          {!loading && !debouncedQuery && (
            <span className="font-mono text-[11px] text-muted-foreground/80 tabular-nums shrink-0">
              {entities.length}
            </span>
          )}
        </div>
      </PageHeader>

      <div className="w-full max-w-4xl mx-auto px-8 pt-7 pb-16 space-y-5">
        <p className="text-[13px] text-muted-foreground leading-relaxed px-1">
          AI 在写入时自动识别的概念、人物、工具与文档，按提及次数排序。
        </p>

        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="card animate-pulse p-3.5 h-16" />
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
                className="w-full rounded-lg border border-border bg-card pl-9 pr-8 py-2 text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-foreground/20"
              />
              {searching && (
                <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 animate-spin text-muted-foreground/60" strokeWidth={1.75} />
              )}
            </div>

            {entities.length === 0 ? (
              <p className="px-1 py-8 text-center text-[13px] text-muted-foreground">
                没有匹配「{debouncedQuery}」的实体
              </p>
            ) : (
              <div className="grid gap-1.5">
                {entities.map((e) => {
                  const open = openId === e.id
                  return (
                    <div key={e.id} className="card-interactive px-3.5 py-3">
                      <button
                        type="button"
                        onClick={() => setOpenId(open ? null : e.id)}
                        className="w-full flex items-center gap-3 text-left"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <h3 className="font-medium text-[14.5px] text-foreground tracking-[-0.005em] truncate">
                              {e.display}
                            </h3>
                            <span className="shrink-0 rounded border border-border/60 bg-muted/40 px-1.5 py-px text-[10.5px] text-muted-foreground/85">
                              {entityKindLabel(e.kind)}
                            </span>
                          </div>
                          <p className="text-[11.5px] text-muted-foreground/80 mt-0.5 tabular-nums">
                            {e.mention_count} 篇笔记提及
                          </p>
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
    </div>
  )
}
