/**
 * 图谱（Graph）— 实体共现图的力导向可视化
 *
 * 数据源 GET /api/v1/graph：实体为节点（大小 = 提及次数，颜色 = kind），
 * 共现为边（权重 = 共享文档数）。
 * - 默认全库 top-N 总览；搜索框聚焦某实体（BFS 邻居局部图）
 * - kind 筛选（服务端过滤，边随之重算）；节点点击侧栏详情（相关实体 + 相关笔记）
 * - 悬停高亮、拖拽、滚轮缩放 / 平移，双击节点直接聚焦
 */

import { useEffect, useMemo, useState } from 'react'
import { Crosshair, Loader2, Network, Search, X } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import PageHeader from '../components/PageHeader'
import EntityGraph from '../components/EntityGraph'
import { EntityMentions } from '../components/EntityPanel'
import { ENTITY_KIND_LABEL, entityKindLabel, type EntitySummary } from '../lib/entities'
import { graphKindColor, type GraphCenter, type GraphData, type GraphNode } from '../lib/graph'

const KIND_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'concept', label: ENTITY_KIND_LABEL.concept },
  { id: 'person', label: ENTITY_KIND_LABEL.person },
  { id: 'tool', label: ENTITY_KIND_LABEL.tool },
  { id: 'doc', label: ENTITY_KIND_LABEL.doc },
] as const

type KindFilter = (typeof KIND_FILTERS)[number]['id']

function buildQuery(center: GraphCenter | null, kind: string | null): string {
  const p = new URLSearchParams()
  p.set('min_mention', '2')
  if (center) {
    p.set('center', center.id)
    p.set('center_type', center.type)
  }
  if (kind) p.set('kind', kind)
  return '/graph?' + p.toString()
}

/** 侧栏详情：实体元信息 + 相关实体（图中邻居）+ 相关笔记（复用 EntityMentions） */
function DetailPanel({
  node,
  neighbors,
  onFocus,
  onClose,
}: {
  node: GraphNode
  neighbors: GraphNode[]
  onFocus: (id: string) => void
  onClose: () => void
}) {
  return (
    <aside className="lg:w-80 shrink-0 flex flex-col min-h-0 overflow-y-auto rounded-xl border border-border bg-card">
      <div className="flex items-start justify-between gap-2 px-4 pt-3.5 pb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-medium text-[15px] text-foreground tracking-[-0.005em] truncate">
              {node.display}
            </h2>
            <span className="shrink-0 inline-flex items-center gap-1 rounded border border-border/60 bg-muted/40 px-1.5 py-px text-[10.5px] text-muted-foreground">
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: graphKindColor(node.kind) }}
              />
              {entityKindLabel(node.kind)}
            </span>
          </div>
          <p className="text-[11.5px] text-muted-foreground mt-0.5 tabular-nums">
            {node.mention_count} 篇笔记提及
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 p-1 -m-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          aria-label="关闭详情"
        >
          <X className="w-4 h-4" strokeWidth={1.75} />
        </button>
      </div>

      <div className="px-4 pb-3">
        <button
          type="button"
          onClick={() => onFocus(node.id)}
          className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-background hover:bg-accent hover:border-foreground/20 text-[12.5px] text-foreground py-1.5 transition-colors"
        >
          <Crosshair className="w-3.5 h-3.5" strokeWidth={1.75} />
          以此实体为中心
        </button>
      </div>

      {neighbors.length > 0 && (
        <div className="px-4 pb-3">
          <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-2">
            相关实体
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {neighbors.map((nb) => (
              <button
                key={nb.id}
                type="button"
                onClick={() => onFocus(nb.id)}
                className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-0.5 text-[12px] text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors"
              >
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: graphKindColor(nb.kind) }}
                />
                {nb.display}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="px-4 pb-4 border-t border-border/50 pt-3">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-2">
          相关笔记
        </h3>
        <EntityMentions entityId={node.id} />
      </div>
    </aside>
  )
}

export default function GraphPage() {
  const [center, setCenter] = useState<GraphCenter | null>(null)
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [suggestions, setSuggestions] = useState<EntitySummary[]>([])
  const [searching, setSearching] = useState(false)

  const kind = kindFilter === 'all' ? null : kindFilter
  const { data, loading, error } = useApiQuery(
    () => api.get<GraphData>(buildQuery(center, kind)),
    [center, kind],
  )

  const nodes = data?.nodes ?? []
  const edges = data?.edges ?? []

  // 切换中心后清空选中（旧节点可能不在新图中）
  useEffect(() => {
    setSelectedId(null)
    setSearch('')
    setSuggestions([])
  }, [center])

  // 搜索建议（聚焦用）
  useEffect(() => {
    const q = search.trim()
    if (!q) {
      setSuggestions([])
      return
    }
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await api.get<{ entities: EntitySummary[] }>(
          `/entities?q=${encodeURIComponent(q)}&limit=8`,
        )
        setSuggestions(res.entities)
      } catch {
        setSuggestions([])
      } finally {
        setSearching(false)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [search])

  const selectedNode = useMemo(() => nodes.find((n) => n.id === selectedId) ?? null, [nodes, selectedId])

  // 选中节点的图中邻居（含共现权重，按提及次数倒序）
  const neighbors = useMemo(() => {
    if (!selectedNode) return []
    const ids = new Set<string>()
    for (const e of edges) {
      if (e.source === selectedNode.id) ids.add(e.target as string)
      if (e.target === selectedNode.id) ids.add(e.source as string)
    }
    return nodes.filter((n) => ids.has(n.id)).sort((a, b) => b.mention_count - a.mention_count)
  }, [selectedNode, nodes, edges])

  const focusEntity = (id: string) => {
    setCenter({ type: 'entity', id })
  }

  const resetView = () => {
    setCenter(null)
    setSelectedId(null)
    setKindFilter('all')
  }

  const empty = !loading && !error && nodes.length === 0

  return (
    <div className="h-full flex flex-col">
      <PageHeader innerClassName="flex items-center gap-4">
        <div className="min-w-0 flex items-center gap-2">
          <h1 className="text-[15px] font-medium text-foreground truncate tracking-[-0.005em]">
            图谱
          </h1>
          {!loading && nodes.length > 0 && (
            <span className="font-mono text-[11px] text-muted-foreground tabular-nums shrink-0">
              {nodes.length} 实体 · {edges.length} 关联
            </span>
          )}
        </div>
        {center && (
          <button
            type="button"
            onClick={resetView}
            className="shrink-0 ml-auto text-[12px] text-muted-foreground hover:text-foreground transition-colors"
          >
            重置总览
          </button>
        )}
      </PageHeader>

      <div className="flex-1 min-h-0 flex flex-col px-4 sm:px-8 pt-4 pb-4 gap-3">
        {/* 控制条 */}
        <div className="shrink-0 flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/60" strokeWidth={1.75} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && suggestions.length > 0) {
                  focusEntity(suggestions[0]!.id)
                }
              }}
              placeholder="聚焦某个实体…"
              className="w-48 rounded-lg border border-border bg-card pl-8 pr-7 py-1.5 text-[12.5px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/30 focus:border-primary/40"
            />
            {searching && (
              <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3 h-3 animate-spin text-muted-foreground/60" strokeWidth={1.75} />
            )}
            {search && !searching && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-foreground transition-colors"
                aria-label="清除"
              >
                <X className="w-3 h-3" strokeWidth={2} />
              </button>
            )}
            {suggestions.length > 0 && (
              <div className="absolute left-0 right-0 top-full mt-1 z-20 rounded-lg border border-border bg-card shadow-floating overflow-hidden">
                {suggestions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => focusEntity(s.id)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-[12.5px] text-foreground hover:bg-accent transition-colors"
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: graphKindColor(s.kind) }}
                    />
                    <span className="min-w-0 flex-1 truncate">{s.display}</span>
                    <span className="shrink-0 text-[10.5px] text-muted-foreground tabular-nums">
                      {s.mention_count}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {KIND_FILTERS.map((f) => {
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
                </button>
              )
            })}
          </div>

          <span className="ml-auto hidden sm:inline text-[11px] text-muted-foreground/60">
            滚轮缩放 · 拖拽平移 · 双击聚焦
          </span>
        </div>

        {/* 图主体 + 详情 */}
        {loading && !data ? (
          <div className="flex-1 min-h-[55vh] card rounded-xl flex items-center justify-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} />
            正在计算图谱…
          </div>
        ) : empty ? (
          <div className="flex-1 min-h-[55vh] card rounded-xl flex flex-col items-center justify-center text-center px-6">
            <div className="empty-icon-tile">
              <Network className="w-5 h-5" />
            </div>
            <h3 className="text-[15px] font-medium text-foreground mb-1.5">
              {center ? '未找到相关实体' : '图谱还是空的'}
            </h3>
            <p className="text-[13px] text-muted-foreground mb-5 max-w-[340px] leading-relaxed">
              {center
                ? '该实体还没有足够的共现关联，换个实体聚焦试试。'
                : '写入文档后，AI 会自动识别其中的概念、人物与工具，共现关系会在这里织成一张知识图谱。'}
            </p>
            {center && (
              <button
                type="button"
                onClick={resetView}
                className="rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-primary-foreground hover:bg-primary-hover transition-colors"
              >
                返回总览
              </button>
            )}
          </div>
        ) : error ? (
          <div className="flex-1 min-h-[55vh] card rounded-xl flex items-center justify-center text-[13px] text-destructive">
            图谱加载失败：{error.message}
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-3">
            <div className="flex-1 min-h-[55vh] lg:min-h-0 card rounded-xl overflow-hidden">
              <EntityGraph
                nodes={nodes}
                edges={edges}
                centerId={center?.type === 'entity' ? center.id : null}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onFocus={focusEntity}
              />
            </div>
            {selectedNode && (
              <DetailPanel
                node={selectedNode}
                neighbors={neighbors}
                onFocus={focusEntity}
                onClose={() => setSelectedId(null)}
              />
            )}
          </div>
        )}

        {data?.truncated && (
          <p className="shrink-0 text-[11px] text-muted-foreground/70">
            图谱较大，仅展示部分节点与关联（{nodes.length} 实体）。使用搜索聚焦某个实体查看局部视图。
          </p>
        )}
      </div>
    </div>
  )
}
