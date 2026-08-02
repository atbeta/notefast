/**
 * 图谱（Graph）— 实体共现图 / 笔记关联图 的力导向可视化
 *
 * 数据源 GET /api/v1/graph：
 * - entities 模式：实体为节点（大小=提及次数、颜色=kind），共现为边
 * - docs 模式：笔记为节点（方角、大小=内容量），关联为边（共享实体/引用）
 *
 * 交互：模式切换；搜索聚焦（实体模式按实体名、笔记模式按标题过滤）；
 * 悬停高亮 + tooltip；点击侧栏详情（相关节点 + 打开笔记）；kind 筛选与
 * 最低提及密度（仅实体模式）；URL 参数（?mode=&center=&center_type=）深链。
 */

import { useEffect, useMemo, useState } from 'react'
import { Crosshair, FileText, Loader2, Network, RefreshCw, Search, X } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import PageHeader from '../components/PageHeader'
import EntityGraph from '../components/EntityGraph'
import { EntityMentions } from '../components/EntityPanel'
import { ENTITY_KIND_LABEL, entityKindLabel, type EntitySummary } from '../lib/entities'
import {
  GRAPH_NOTE_COLOR,
  graphKindColor,
  type GraphCenter,
  type GraphData,
  type GraphMode,
  type GraphNode,
} from '../lib/graph'

const KIND_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'concept', label: ENTITY_KIND_LABEL.concept },
  { id: 'person', label: ENTITY_KIND_LABEL.person },
  { id: 'tool', label: ENTITY_KIND_LABEL.tool },
  { id: 'doc', label: ENTITY_KIND_LABEL.doc },
] as const

type KindFilter = (typeof KIND_FILTERS)[number]['id']

/** 最低提及密度：1 = 全部，2 = ≥2（默认），3 = ≥3 */
const MIN_MENTION_OPTS = [1, 2, 3] as const

function parseGraphUrl(search: string): { mode: GraphMode; center: GraphCenter | null } {
  const p = new URLSearchParams(search)
  const mode: GraphMode = p.get('mode') === 'docs' ? 'docs' : 'entities'
  const centerId = (p.get('center') ?? '').trim()
  const centerType = p.get('center_type')
  let center: GraphCenter | null = null
  if (centerId && (centerType === 'entity' || centerType === 'doc')) {
    center = { type: centerType, id: centerId }
  }
  return { mode, center }
}

function buildQuery(mode: GraphMode, center: GraphCenter | null, kind: string | null, minMention: number, titleQ: string): string {
  const p = new URLSearchParams()
  p.set('mode', mode)
  if (mode === 'entities') {
    p.set('min_mention', String(minMention))
  }
  if (center) {
    p.set('center', center.id)
    p.set('center_type', center.type)
  }
  if (kind) p.set('kind', kind)
  if (mode === 'docs' && titleQ.trim()) p.set('q', titleQ.trim())
  return '/graph?' + p.toString()
}

/** 侧栏详情：实体或笔记节点 */
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
  const isDoc = node.type === 'doc'
  return (
    <aside className="lg:w-80 shrink-0 flex flex-col min-h-0 overflow-y-auto rounded-xl border border-border bg-card">
      <div className="flex items-start justify-between gap-2 px-4 pt-3.5 pb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-medium text-[15px] text-foreground tracking-[-0.005em] truncate">
              {node.display}
            </h2>
            {isDoc ? (
              <span className="shrink-0 inline-flex items-center gap-1 rounded border border-border/60 bg-muted/40 px-1.5 py-px text-[10.5px] text-muted-foreground">
                <FileText className="w-3 h-3" strokeWidth={1.75} />
                笔记
              </span>
            ) : (
              <span className="shrink-0 inline-flex items-center gap-1 rounded border border-border/60 bg-muted/40 px-1.5 py-px text-[10.5px] text-muted-foreground">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: graphKindColor(node.kind) }} />
                {entityKindLabel(node.kind)}
              </span>
            )}
          </div>
          <p className="text-[11.5px] text-muted-foreground mt-0.5 tabular-nums">
            {isDoc ? `${node.mention_count} 个块` : `${node.mention_count} 篇笔记提及`}
          </p>
          {node.description && (
            <p className="text-[12px] text-foreground/80 mt-1.5 leading-relaxed">
              {node.description}
            </p>
          )}
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

      <div className="px-4 pb-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onFocus(node.id)}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-background hover:bg-accent hover:border-foreground/20 text-[12.5px] text-foreground py-1.5 px-2.5 transition-colors"
        >
          <Crosshair className="w-3.5 h-3.5" strokeWidth={1.75} />
          {isDoc ? '以此笔记为中心' : '以此实体为中心'}
        </button>
        {isDoc && (
          <a
            href={`/doc/${node.id}`}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-background hover:bg-accent hover:border-foreground/20 text-[12.5px] text-foreground py-1.5 px-2.5 transition-colors"
          >
            <FileText className="w-3.5 h-3.5" strokeWidth={1.75} />
            打开笔记
          </a>
        )}
      </div>

      {neighbors.length > 0 && (
        <div className="px-4 pb-3">
          <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-2">
            {isDoc ? '相关笔记' : '相关实体'}
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {neighbors.map((nb) => (
              <button
                key={nb.id}
                type="button"
                onClick={() => onFocus(nb.id)}
                className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-0.5 text-[12px] text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors"
              >
                {isDoc ? (
                  <span className="w-1.5 h-1.5 rounded-[2px]" style={{ background: GRAPH_NOTE_COLOR }} />
                ) : (
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: graphKindColor(nb.kind) }} />
                )}
                {nb.display}
              </button>
            ))}
          </div>
        </div>
      )}

      {!isDoc && (
        <div className="px-4 pb-4 border-t border-border/50 pt-3">
          <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-2">
            相关笔记
          </h3>
          <EntityMentions entityId={node.id} />
        </div>
      )}
    </aside>
  )
}

export default function GraphPage() {
  const location = useLocation()
  const initial = useMemo(() => parseGraphUrl(location.search), [location.search])
  const [mode, setMode] = useState<GraphMode>(initial.mode)
  const [center, setCenter] = useState<GraphCenter | null>(initial.center)
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [minMention, setMinMention] = useState<number>(2)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [titleQ, setTitleQ] = useState('')
  const [suggestions, setSuggestions] = useState<EntitySummary[] | GraphNode[]>([])
  const [searching, setSearching] = useState(false)
  const [layoutKey, setLayoutKey] = useState(0)

  const kind = kindFilter === 'all' ? null : kindFilter
  const { data, loading, error } = useApiQuery(
    () => api.get<GraphData>(buildQuery(mode, center, kind, minMention, titleQ)),
    [mode, center, kind, minMention, titleQ],
  )

  const nodes = data?.nodes ?? []
  const edges = data?.edges ?? []

  // 切换模式/中心后清空选中（旧节点可能不在新图中）
  useEffect(() => {
    setSelectedId(null)
    setSearch('')
    setSuggestions([])
    setTitleQ('')
  }, [center, mode])

  // 搜索建议（实体模式：/entities；笔记模式：docs 标题过滤即当前图节点）
  useEffect(() => {
    const q = search.trim()
    if (!q) {
      setSuggestions([])
      if (mode === 'docs') setTitleQ('')
      return
    }
    if (mode === 'docs') {
      setTitleQ(q)
      return
    }
    setTitleQ('')
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
  }, [search, mode])

  // 笔记模式：建议直接取自标题过滤后的节点
  const docSuggestions = mode === 'docs' && titleQ.trim() ? nodes.slice(0, 8) : []

  const selectedNode = useMemo(() => nodes.find((n) => n.id === selectedId) ?? null, [nodes, selectedId])

  // 选中节点的图中邻居（按提及次数/内容量倒序）
  const neighbors = useMemo(() => {
    if (!selectedNode) return []
    const ids = new Set<string>()
    for (const e of edges) {
      if (e.source === selectedNode.id) ids.add(e.target as string)
      if (e.target === selectedNode.id) ids.add(e.source as string)
    }
    return nodes.filter((n) => ids.has(n.id)).sort((a, b) => b.mention_count - a.mention_count)
  }, [selectedNode, nodes, edges])

  const focusNode = (id: string) => {
    setCenter(mode === 'docs' ? { type: 'doc', id } : { type: 'entity', id })
  }

  const resetView = () => {
    setCenter(null)
    setSelectedId(null)
    setKindFilter('all')
  }

  const empty = !loading && !error && nodes.length === 0
  const centerLabel = data?.center?.label

  return (
    <div className="h-full flex flex-col">
      <PageHeader innerClassName="flex items-center gap-3">
        <div className="min-w-0 flex items-center gap-2">
          <h1 className="text-[15px] font-medium text-foreground truncate tracking-[-0.005em]">
            图谱
          </h1>
          {!loading && nodes.length > 0 && (
            <span className="font-mono text-[11px] text-muted-foreground tabular-nums shrink-0">
              {nodes.length} {mode === 'docs' ? '笔记' : '实体'} · {edges.length} 关联
            </span>
          )}
        </div>
        {centerLabel && (
          <span className="hidden md:inline-flex items-center gap-1 min-w-0 text-[12px] text-muted-foreground">
            聚焦
            <span className="font-medium text-foreground truncate max-w-[160px]">{centerLabel}</span>
          </span>
        )}
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
          {/* 模式切换 */}
          <div className="flex items-center rounded-lg border border-border bg-card p-0.5">
            {(['entities', 'docs'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors ${
                  mode === m ? 'bg-primary-soft text-primary' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {m === 'entities' ? '实体图谱' : '笔记图谱'}
              </button>
            ))}
          </div>

          {/* 搜索聚焦 */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/60" strokeWidth={1.75} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={mode === 'docs' ? '筛选笔记…' : '聚焦某个实体…'}
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
            {(mode === 'docs' ? docSuggestions.length > 0 : suggestions.length > 0) && (
              <div className="absolute left-0 right-0 top-full mt-1 z-20 rounded-lg border border-border bg-card shadow-floating overflow-hidden">
                {(mode === 'docs' ? docSuggestions : suggestions).map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      if (mode === 'docs') {
                        setCenter({ type: 'doc', id: s.id })
                      } else {
                        setCenter({ type: 'entity', id: s.id })
                      }
                      setSearch('')
                      setTitleQ('')
                      setSuggestions([])
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-[12.5px] text-foreground hover:bg-accent transition-colors"
                  >
                    {mode === 'docs' ? (
                      <span className="w-2 h-2 rounded-[2px] shrink-0" style={{ background: GRAPH_NOTE_COLOR }} />
                    ) : (
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: graphKindColor((s as EntitySummary).kind) }} />
                    )}
                    <span className="min-w-0 flex-1 truncate">{s.display}</span>
                    <span className="shrink-0 text-[10.5px] text-muted-foreground tabular-nums">
                      {mode === 'docs' ? '笔记' : (s as EntitySummary).mention_count}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 实体模式：kind 筛选 + 密度 */}
          {mode === 'entities' && (
            <>
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
              <select
                value={minMention}
                onChange={(e) => setMinMention(Number(e.target.value))}
                title="最低提及次数（密度）"
                className="rounded-md border border-border bg-card px-2 py-1 text-[12px] text-muted-foreground focus:outline-none"
              >
                {MIN_MENTION_OPTS.map((n) => (
                  <option key={n} value={n}>
                    提及 ≥ {n}
                  </option>
                ))}
              </select>
            </>
          )}

          <button
            type="button"
            onClick={() => setLayoutKey((k) => k + 1)}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[12px] text-muted-foreground hover:text-foreground hover:bg-muted/70 transition-colors"
            title="重新布局（重置缩放/位置）"
          >
            <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} />
            重新布局
          </button>

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
              {mode === 'docs'
                ? titleQ
                  ? '没有匹配的笔记'
                  : '图谱还是空的'
                : center
                  ? '未找到相关实体'
                  : '图谱还是空的'}
            </h3>
            <p className="text-[13px] text-muted-foreground mb-5 max-w-[340px] leading-relaxed">
              {mode === 'docs'
                ? titleQ
                  ? '换个标题关键词试试。'
                  : '写入文档后，共享实体与引用会把笔记连成关联图谱。'
                : center
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
                key={`${mode}-${layoutKey}`}
                nodes={nodes}
                edges={edges}
                mode={mode}
                centerId={center ? center.id : null}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onFocus={focusNode}
              />
            </div>
            {selectedNode && (
              <DetailPanel
                node={selectedNode}
                neighbors={neighbors}
                onFocus={focusNode}
                onClose={() => setSelectedId(null)}
              />
            )}
          </div>
        )}

        {data?.truncated && (
          <p className="shrink-0 text-[11px] text-muted-foreground/70">
            图谱较大，仅展示部分节点与关联（{nodes.length} 个）。
            使用搜索聚焦，或「重新布局」重置视图。
          </p>
        )}
      </div>
    </div>
  )
}
