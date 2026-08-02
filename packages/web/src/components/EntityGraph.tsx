/**
 * 实体/笔记共现图 — d3-force 力导向 SVG 渲染
 *
 * 数据：节点（大小 = 提及次数/块数；实体 = kind 着色圆形带高光与光晕，
 * 笔记 = 迷你卡片：卡片底色 + 细边 + primary 竖条 + 文本行 glyph），
 * 边（透明度/宽度 = 权重，悬停/选中时相关边染焦点节点颜色）。
 * 画布为屏幕空间点阵背景；标签带卡片色 halo 保证可读性。
 *
 * 交互：
 * - 画布：滚轮缩放（光标处）、空白拖拽平移、空白单击取消选中
 * - 节点：拖拽（fx/fy 固定到落点）、单击选中、双击聚焦（重新以该节点为中心）
 * - 悬停/选中：高亮该节点与其邻居、其余压暗（悬停优先于选中）；tooltip 显示名称 / kind / 次数
 * - 锚点节点（centerId）固定于画布中心，新节点从中心浮现（平滑聚焦过渡）
 * - 图例覆盖（kind 颜色 / 笔记样式 + 大小与边的含义）
 *
 * 渲染：节点坐标由 d3-force 模拟维护（tick 经 rAF 节流触发重渲染）；
 * 图结构（graphKey）变化时重建模拟，但**复用旧节点坐标**实现连续过渡。
 * kind 颜色走 CSS 变量（跟随深浅主题，见 styles/tokens.css 的 --graph-*）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
} from 'd3-force'
import {
  graphKindColor,
  type GraphEdge,
  type GraphMode,
  type GraphNode,
} from '../lib/graph'
import { entityKindLabel } from '../lib/entities'

interface SimNode extends GraphNode {
  x: number
  y: number
  vx: number
  vy: number
  fx: number | null
  fy: number | null
}

type SimEdge = Omit<GraphEdge, 'source' | 'target'> & {
  source: SimNode | string
  target: SimNode | string
}

interface EntityGraphProps {
  nodes: GraphNode[]
  edges: GraphEdge[]
  mode: GraphMode
  /** 锚点节点 id（固定于画布中心） */
  centerId?: string | null
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** 聚焦：以该节点为中心重新拉取 */
  onFocus: (id: string) => void
}

const MIN_ZOOM = 0.25
const MAX_ZOOM = 3
const LABEL_MAX = 14

function nodeRadius(mc: number, maxMc: number): number {
  return 5 + 13 * Math.min(1, Math.sqrt(mc) / Math.sqrt(Math.max(maxMc, 1)))
}

/** 笔记节点尺寸（宽；高 ≈ 0.55×，迷你卡片） */
function docWidth(mc: number, maxMc: number): number {
  return 46 + 54 * Math.min(1, Math.sqrt(mc) / Math.sqrt(Math.max(maxMc, 1)))
}

export default function EntityGraph({
  nodes,
  edges,
  mode,
  centerId,
  selectedId,
  onSelect,
  onFocus,
}: EntityGraphProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const viewRef = useRef(view)
  viewRef.current = view
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [, setTick] = useState(0)
  // 自动 fit-to-view：图重建后跟随布局收敛持续取景，用户缩放/平移/拖节点即停
  const autoFitRef = useRef(false)
  const prevGraphKeyRef = useRef('')

  // 当前所有节点的取景框 → 视图变换（留边距，允许小图略微放大）
  const fitView = () => {
    const ns = simNodesRef.current
    if (ns.length === 0) return
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const n of ns) {
      minX = Math.min(minX, n.x)
      minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x)
      maxY = Math.max(maxY, n.y)
    }
    const pad = 70
    const bw = Math.max(1, maxX - minX)
    const bh = Math.max(1, maxY - minY)
    const k = Math.min(
      MAX_ZOOM,
      1.15,
      Math.max(MIN_ZOOM, Math.min((size.w - pad * 2) / bw, (size.h - pad * 2) / bh)),
    )
    setView({
      k,
      x: size.w / 2 - (minX + bw / 2) * k,
      y: size.h / 2 - (minY + bh / 2) * k,
    })
  }

  const maxMc = useMemo(() => Math.max(1, ...nodes.map((n) => n.mention_count)), [nodes])

  // 容器尺寸（ResizeObserver）
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r && r.width > 0) setSize({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 模拟节点：由 d3-force 直接写 x/y。用 ref 持有（避免每次渲染生成新数组
  // 触发模拟重建）；数据真变化时由下面的 effect 重写节点与重启模拟。
  const simNodesRef = useRef<SimNode[]>([])
  // 模拟边：同样用 ref 持有（与节点同生命周期，见下方 effect）
  const simEdgesRef = useRef<SimEdge[]>([])
  // 数据快照（节点 id 集合），用于判断「图结构」是否真的变了，避免渲染导致重启
  const graphKey = nodes
    .map((n) => `${n.id}:${n.mention_count}:${n.kind}`)
    .sort()
    .join('|')
    + '|' + edges
    .map((e) => `${e.source}>${e.target}:${e.weight}`)
    .sort()
    .join('|')

  // d3-force 力导向模拟：
  // - 只在「图结构（graphKey）或容器尺寸」真正变化时重建，绝不因渲染/重绘重启。
  // - 平滑聚焦过渡：重建时复用旧节点坐标（旧图节点不动，新节点从中心浮现），
  //   而非把所有节点重新摆到圆环（聚焦会「炸开」）。
  useEffect(() => {
    if (size.w === 0 || size.h === 0 || nodes.length === 0) return
    const cx = size.w / 2
    const cy = size.h / 2
    const ring = Math.max(40, Math.min(size.w, size.h) * 0.34)
    const prev = new Map(simNodesRef.current.map((n) => [n.id, { x: n.x, y: n.y }]))
    simNodesRef.current = nodes.map((n, i) => {
      const old = prev.get(n.id)
      const angle = (i / Math.max(nodes.length, 1)) * Math.PI * 2
      return {
        ...n,
        // 旧节点保留坐标（连续过渡）；新节点从中心附近浮现
        x: old?.x ?? cx + ring * 0.5 * Math.cos(angle) + (Math.random() - 0.5) * 60,
        y: old?.y ?? cy + ring * 0.5 * Math.sin(angle) + (Math.random() - 0.5) * 60,
        vx: 0,
        vy: 0,
        fx: n.id === centerId ? cx : null,
        fy: n.id === centerId ? cy : null,
      }
    })
    const simEdges: SimEdge[] = edges.map((e) => ({ ...e }))
    simEdgesRef.current = simEdges
    const radiusOf = (d: SimNode) =>
      (d.type === 'doc' ? docWidth(d.mention_count, maxMc) / 2 : nodeRadius(d.mention_count, maxMc)) + 10
  const sim: Simulation<SimNode, undefined> = forceSimulation<SimNode>(simNodesRef.current)
      .force(
        'link',
        forceLink<SimNode, SimEdge>(simEdges)
          .id((d) => d.id)
          .distance(mode === 'docs' ? 120 : 95)
          .strength(0.4),
      )
      .force('charge', forceManyBody().strength(mode === 'docs' ? -160 : -200))
      .force('center', forceCenter(size.w / 2, size.h / 2))
      // 弱向心力：收紧孤立节点组成的稀疏点云（笔记模式大量无关联笔记），
      // 让 fit-to-view 落在更高缩放级别；锚点 fx/fy 固定不受影响
      .force('x', forceX(size.w / 2).strength(mode === 'docs' ? 0.06 : 0.03))
      .force('y', forceY(size.h / 2).strength(mode === 'docs' ? 0.06 : 0.03))
      .force('collide', forceCollide<SimNode>().radius(radiusOf))
    // 图结构重建后自动缩放至全图可见（用户交互即停止，见 wheel/pointerdown）；
    // 仅图结构变化时触发——容器 resize（如详情面板开合）不重置用户视角
    autoFitRef.current = graphKey !== prevGraphKeyRef.current
    prevGraphKeyRef.current = graphKey
    let raf = 0
    sim.on('tick', () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (autoFitRef.current) fitView()
        setTick((t) => t + 1)
      })
    })
    return () => {
      cancelAnimationFrame(raf)
      sim.stop()
    }
  }, [graphKey, size.w, size.h, centerId, maxMc, mode])

  // 原生 wheel（passive:false 才能 preventDefault 缩放）。
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      autoFitRef.current = false
      const rect = svg.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      setView((v) => {
        const k2 = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)))
        return { k: k2, x: mx - ((mx - v.x) * k2) / v.k, y: my - ((my - v.y) * k2) / v.k }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [size.w, size.h])

  // ───────────────────── 交互状态 ─────────────────────
  const dragRef = useRef<{ id: string; moved: boolean } | null>(null)
  const panRef = useRef<{ sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null)
  const suppressClickRef = useRef(false)

  const toWorld = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect()
    const v = viewRef.current
    return { x: (clientX - rect.left - v.x) / v.k, y: (clientY - rect.top - v.y) / v.k }
  }

  const onSvgPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    autoFitRef.current = false
    panRef.current = { sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y, moved: false }
    svgRef.current?.setPointerCapture(e.pointerId)
  }

  const onSvgPointerMove = (e: React.PointerEvent) => {
    if (dragRef.current) {
      const node = simNodesRef.current.find((n) => n.id === dragRef.current!.id)
      if (node) {
        const w = toWorld(e.clientX, e.clientY)
        node.x = w.x
        node.y = w.y
        node.fx = w.x
        node.fy = w.y
        setTick((t) => t + 1)
      }
      return
    }
    if (panRef.current) {
      const p = panRef.current
      const dx = e.clientX - p.sx
      const dy = e.clientY - p.sy
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) p.moved = true
      if (p.moved) {
        setView((v) => ({ x: p.vx + dx, y: p.vy + dy, k: v.k }))
      }
    }
  }

  const onSvgPointerUp = () => {
    const p = panRef.current
    panRef.current = null
    if (dragRef.current) {
      if (dragRef.current.moved) suppressClickRef.current = true
      dragRef.current = null
      return
    }
    if (p && !p.moved) onSelect(null)
  }

  const onNodePointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation()
    autoFitRef.current = false
    dragRef.current = { id, moved: false }
    const node = simNodesRef.current.find((n) => n.id === id)
    if (node) {
      const w = toWorld(e.clientX, e.clientY)
      node.fx = w.x
      node.fy = w.y
    }
    // 捕获到节点 <g> 自身：pointermove/up 冒泡到 svg 走拖拽逻辑，
    // 且后续 click 仍落在节点上（捕获到 svg 会把 click 重定向到 svg，onSelect 不触发）
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onNodeClick = (_e: React.MouseEvent, id: string) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    onSelect(id)
  }

  // ───────────────────── 派生渲染数据 ─────────────────────
  const maxWeight = useMemo(() => Math.max(1, ...edges.map((e) => e.weight)), [edges])

  // 焦点邻居集合（含自身）：悬停优先，无悬停时回落到选中节点——
  // 选中实体后图中仅它与相关实体保持全亮，其余压暗
  const focusNeighbors = useMemo(() => {
    const fid = hoverId ?? selectedId
    if (!fid) return null
    // 焦点节点已不在当前图（如切换 kind 筛选后选中态未清）时不压暗
    if (!simNodesRef.current.some((n) => n.id === fid)) return null
    const set = new Set<string>([fid])
    for (const e of edges) {
      if (e.source === fid) set.add(e.target as string)
      if (e.target === fid) set.add(e.source as string)
    }
    return set
  }, [hoverId, selectedId, edges, graphKey])

  // 与选中/悬停节点相邻的边集合
  const focusEdges = useMemo(() => {
    const fid = hoverId ?? selectedId
    if (!fid) return null
    const set = new Set<SimEdge>()
    for (const e of simEdgesRef.current) {
      const s = typeof e.source === 'string' ? e.source : e.source.id
      const t = typeof e.target === 'string' ? e.target : e.target.id
      if (s === fid || t === fid) set.add(e)
    }
    return set
  }, [hoverId, selectedId, graphKey])

  const hoverNode = hoverId ? (simNodesRef.current.find((n) => n.id === hoverId) ?? null) : null

  // 焦点（悬停优先，其次选中）节点的主题色：相关边用它染色，增强关联感
  const focusColor = useMemo(() => {
    const fid = hoverId ?? selectedId
    if (!fid) return null
    const n = simNodesRef.current.find((nd) => nd.id === fid)
    if (!n) return null
    return n.type === 'doc' ? 'rgb(var(--primary))' : graphKindColor(n.kind)
  }, [hoverId, selectedId, graphKey])
  // tooltip 屏幕坐标（在 pan/zoom 变换之外，随节点移动）
  const tooltipPos =
    hoverNode && !dragRef.current
      ? {
          x: hoverNode.x * view.k + view.x,
          y: hoverNode.y * view.k + view.y,
        }
      : null

  // 标签按缩放级别显隐：缩得太小时全部标签只会糊成噪点，
  // 只保留悬停/选中节点的标签（tooltip 仍在）
  const labelsOn = view.k >= 0.55
  const showLabel = (n: SimNode) =>
    hoverId === n.id ||
    selectedId === n.id ||
    (labelsOn &&
      (mode === 'docs' ||
        n.distance === 0 ||
        nodeRadius(n.mention_count, maxMc) >= 8))

  if (size.w === 0) {
    return (
      <div ref={containerRef} className="h-full w-full">
        <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground/60">
          {t('entityGraph.layoutComputing')}
        </div>
      </div>
    )
  }

  const isDoc = mode === 'docs'

  return (
    <div ref={containerRef} className="h-full w-full relative overflow-hidden select-none">
      <svg
        ref={svgRef}
        width={size.w}
        height={size.h}
        className="block touch-none"
        style={{ cursor: hoverId ? 'pointer' : 'grab' }}
        onPointerDown={onSvgPointerDown}
        onPointerMove={onSvgPointerMove}
        onPointerUp={onSvgPointerUp}
        onPointerCancel={onSvgPointerUp}
      >
        <defs>
          {/* 节点柔和投影（共享，深浅主题通用——阴影本就是暗色） */}
          <filter id="graphNodeShadow" x="-60%" y="-60%" width="220%" height="220%">
            <feDropShadow dx="0" dy="1.5" stdDeviation="2.5" floodColor="#141412" floodOpacity="0.14" />
          </filter>
          {/* 节点顶部高光：白色径向渐隐，叠在 kind 底色上形成通透感 */}
          <radialGradient id="graphSheen" cx="35%" cy="28%" r="80%">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.42" />
            <stop offset="55%" stopColor="#fff" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          {/* 画布点阵背景（屏幕空间，不随平移缩放） */}
          <pattern id="graphDots" width="26" height="26" patternUnits="userSpaceOnUse">
            <circle cx="1.1" cy="1.1" r="1.1" style={{ fill: 'rgb(var(--graph-edge))' }} opacity="0.55" />
          </pattern>
        </defs>
        <rect width={size.w} height={size.h} fill="url(#graphDots)" />
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {/* 边 */}
          {simEdgesRef.current.map((e, i) => {
            const s = typeof e.source === 'string' ? null : e.source
            const t = typeof e.target === 'string' ? null : e.target
            if (!s || !t) return null
            const incident = focusEdges ? focusEdges.has(e) : true
            const dim = focusEdges !== null && !incident
            const highlighted = incident && focusColor !== null
            const w = e.weight / maxWeight
            return (
              <line
                key={i}
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
                strokeLinecap="round"
                style={{ stroke: highlighted ? focusColor : 'rgb(var(--graph-edge))' }}
                strokeWidth={highlighted ? 1 + 1.5 * w : 0.6 + 1.2 * w}
                strokeOpacity={dim ? 0.05 : highlighted ? 0.55 : 0.24 + 0.32 * w}
              />
            )
          })}
          {/* 节点 */}
          {simNodesRef.current.map((n) => {
            const dim = focusNeighbors !== null && !focusNeighbors.has(n.id)
            const opacity = dim ? 0.16 : 1
            const isSelected = n.id === selectedId
            const isHover = n.id === hoverId
            return (
              <g
                key={n.id}
                transform={`translate(${n.x},${n.y})`}
                opacity={opacity}
                onPointerDown={(e) => onNodePointerDown(e, n.id)}
                onClick={(e) => onNodeClick(e, n.id)}
                onDoubleClick={() => onFocus(n.id)}
                onPointerEnter={() => setHoverId(n.id)}
                onPointerLeave={() => setHoverId((h) => (h === n.id ? null : h))}
              >
                <g className="graph-node-enter">
                  {isDoc ? (
                    <DocNodeShape n={n} maxMc={maxMc} isAnchor={n.id === centerId} isHover={isHover} isSelected={isSelected} showLabel={showLabel(n)} />
                  ) : (
                    <EntityNodeShape n={n} maxMc={maxMc} isAnchor={n.id === centerId} isHover={isHover} isSelected={isSelected} showLabel={showLabel(n)} />
                  )}
                </g>
              </g>
            )
          })}
        </g>
      </svg>

      {/* hover tooltip（屏幕坐标，随节点移动） */}
      {hoverNode && tooltipPos && (
        <div
          className="graph-tooltip"
          style={{ left: tooltipPos.x, top: tooltipPos.y, transform: 'translate(-50%, -100%)' }}
        >
          <div className="max-w-[240px] truncate">{hoverNode.display}</div>
          {hoverNode.description && (
            <div className="max-w-[240px] truncate text-[10px] text-muted-foreground/80">
              {hoverNode.description}
            </div>
          )}
          <div className="mt-0.5 text-[10px] text-muted-foreground tabular-nums">
            {hoverNode.type === 'doc'
              ? t('entityGraph.tooltipBlocks', { n: hoverNode.mention_count })
              : t('entityGraph.tooltipMentions', { kind: entityKindLabel(hoverNode.kind), n: hoverNode.mention_count })}
          </div>
        </div>
      )}

      {/* 图例 */}
      <div className="absolute bottom-2.5 left-2.5 z-10 pointer-events-none rounded-lg border border-border bg-card/90 backdrop-blur px-2.5 py-1.5 text-[10.5px] text-muted-foreground leading-relaxed">
        {isDoc ? (
          <>
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-3.5 h-3 rounded-[3px] border"
                style={{ background: 'rgb(var(--graph-note-fill))', borderColor: 'rgb(var(--border-strong))' }}
              />
              <span>{t('entityGraph.legendDoc')}</span>
            </div>
            <div className="mt-1">{t('entityGraph.legendSizeContent')}</div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-1.5">
              {(['concept', 'person', 'tool', 'doc'] as const).map((k) => (
                <span key={k} className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full" style={{ background: graphKindColor(k) }} />
                  <span>{entityKindLabel(k)}</span>
                </span>
              ))}
            </div>
            <div className="mt-1">{t('entityGraph.legendSizeMentions')}</div>
          </>
        )}
      </div>
    </div>
  )
}

/** 实体节点：kind 色圆 + 顶部高光 + 常驻淡光晕；悬停/选中为实色光环 */
function EntityNodeShape({
  n,
  maxMc,
  isAnchor,
  isHover,
  isSelected,
  showLabel,
}: {
  n: SimNode
  maxMc: number
  isAnchor: boolean
  isHover: boolean
  isSelected: boolean
  showLabel: boolean
}) {
  const r = nodeRadius(n.mention_count, maxMc)
  const color = graphKindColor(n.kind)
  return (
    <>
      {/* 隐形放大命中区（点击更易命中） */}
      <circle r={r + 8} fill="transparent" />
      {/* 常驻柔光晕，让节点从点阵背景上浮起 */}
      <circle r={r + 3} fill={color} opacity={0.14} />
      {(isHover || isAnchor) && !isSelected && (
        <circle r={r + 6} fill={color} opacity={isHover ? 0.28 : 0.18} />
      )}
      {isSelected && <circle r={r + 8} fill={color} opacity={0.26} />}
      <circle
        r={r}
        fill={color}
        style={{ stroke: 'rgb(var(--card))' }}
        strokeWidth={1.4}
        filter="url(#graphNodeShadow)"
      />
      <circle r={r} fill="url(#graphSheen)" pointerEvents="none" />
      {isSelected && (
        <circle r={r + 3.5} fill="none" style={{ stroke: 'rgb(var(--primary))' }} strokeWidth={1.5} />
      )}
      {showLabel && (
        <text y={r + 13} textAnchor="middle" className="graph-node-label" style={{ fill: 'rgb(var(--foreground))' }}>
          {n.display.length > LABEL_MAX ? n.display.slice(0, LABEL_MAX) + '…' : n.display}
        </text>
      )}
    </>
  )
}

/** 笔记节点：迷你笔记卡片 — 卡片底色 + 细边 + 投影 + primary 竖条 + 文本行 glyph，标题在卡片下方 */
function DocNodeShape({
  n,
  maxMc,
  isAnchor,
  isHover,
  isSelected,
  showLabel,
}: {
  n: SimNode
  maxMc: number
  isAnchor: boolean
  isHover: boolean
  isSelected: boolean
  showLabel: boolean
}) {
  const w = docWidth(n.mention_count, maxMc)
  const h = Math.max(26, w * 0.55)
  const glyphX = -w / 2 + 10 // 竖条右侧起点
  return (
    <>
      {/* 隐形放大命中区 */}
      <rect x={-w / 2 - 8} y={-h / 2 - 8} width={w + 16} height={h + 16} fill="transparent" />
      {(isHover || isAnchor) && !isSelected && (
        <rect
          x={-w / 2 - 4}
          y={-h / 2 - 4}
          width={w + 8}
          height={h + 8}
          rx={11}
          fill="rgb(var(--primary))"
          opacity={isHover ? 0.2 : 0.12}
        />
      )}
      {isSelected && (
        <rect
          x={-w / 2 - 6}
          y={-h / 2 - 6}
          width={w + 12}
          height={h + 12}
          rx={13}
          fill="rgb(var(--primary))"
          opacity={0.2}
        />
      )}
      <rect
        x={-w / 2}
        y={-h / 2}
        width={w}
        height={h}
        rx={8}
        style={{
          fill: 'rgb(var(--graph-note-fill))',
          stroke: isHover ? 'rgb(var(--border-strong))' : 'rgb(var(--border))',
        }}
        strokeWidth={1}
        filter="url(#graphNodeShadow)"
      />
      {/* 左侧 primary 竖条：笔记的标识色 */}
      <rect x={-w / 2 + 4} y={-h / 2 + 5} width={3} height={h - 10} rx={1.5} fill="rgb(var(--primary))" opacity={0.7} />
      {/* 文本行 glyph：标题行 + 正文行，暗示「这是一篇笔记」 */}
      <rect x={glyphX} y={-h / 2 + 7} width={w - 24} height={3.5} rx={1.75} fill="rgb(var(--foreground))" opacity={0.4} />
      <rect x={glyphX} y={-h / 2 + 13.5} width={(w - 24) * 0.62} height={2.5} rx={1.25} fill="rgb(var(--foreground))" opacity={0.2} />
      {isSelected && (
        <rect
          x={-w / 2 - 3}
          y={-h / 2 - 3}
          width={w + 6}
          height={h + 6}
          rx={11}
          fill="none"
          style={{ stroke: 'rgb(var(--primary))' }}
          strokeWidth={1.5}
        />
      )}
      {showLabel && (
        <text
          y={h / 2 + 13}
          textAnchor="middle"
          className="graph-node-label"
          style={{ fill: 'rgb(var(--foreground))' }}
        >
          {n.display.length > LABEL_MAX ? n.display.slice(0, LABEL_MAX) + '…' : n.display}
        </text>
      )}
    </>
  )
}
