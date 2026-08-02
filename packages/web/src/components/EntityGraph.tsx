/**
 * 实体/笔记共现图 — d3-force 力导向 SVG 渲染
 *
 * 数据：节点（大小 = 提及次数/块数，颜色 = kind，笔记为方角墨色节点），
 * 边（透明度/宽度 = 权重）。
 *
 * 交互：
 * - 画布：滚轮缩放（光标处）、空白拖拽平移、空白单击取消选中
 * - 节点：拖拽（fx/fy 固定到落点）、单击选中、双击聚焦（重新以该节点为中心）
 * - 悬停：高亮节点与其邻居、其余压暗；tooltip 显示名称 / kind / 次数
 * - 锚点节点（centerId）固定于画布中心，新节点从中心浮现（平滑聚焦过渡）
 * - 图例覆盖（kind 颜色 / 笔记样式 + 大小与边的含义）
 *
 * 渲染：节点坐标由 d3-force 模拟维护（tick 经 rAF 节流触发重渲染）；
 * 图结构（graphKey）变化时重建模拟，但**复用旧节点坐标**实现连续过渡。
 * kind 颜色走 CSS 变量（跟随深浅主题，见 styles/tokens.css 的 --graph-*）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
} from 'd3-force'
import {
  GRAPH_NOTE_COLOR,
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

/** 笔记节点尺寸（宽；高 ≈ 0.6×，圆角矩形） */
function docWidth(mc: number, maxMc: number): number {
  return 34 + 46 * Math.min(1, Math.sqrt(mc) / Math.sqrt(Math.max(maxMc, 1)))
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
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const viewRef = useRef(view)
  viewRef.current = view
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [, setTick] = useState(0)

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
          .distance(mode === 'docs' ? 150 : 95)
          .strength(0.4),
      )
      .force('charge', forceManyBody().strength(mode === 'docs' ? -300 : -200))
      .force('center', forceCenter(size.w / 2, size.h / 2))
      .force('collide', forceCollide<SimNode>().radius(radiusOf))
    let raf = 0
    sim.on('tick', () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
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

  // 悬停邻居集合（含自身）
  const hoverNeighbors = useMemo(() => {
    if (!hoverId) return null
    const set = new Set<string>([hoverId])
    for (const e of edges) {
      if (e.source === hoverId) set.add(e.target as string)
      if (e.target === hoverId) set.add(e.source as string)
    }
    return set
  }, [hoverId, edges])

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
  // tooltip 屏幕坐标（在 pan/zoom 变换之外，随节点移动）
  const tooltipPos =
    hoverNode && !dragRef.current
      ? {
          x: hoverNode.x * view.k + view.x,
          y: hoverNode.y * view.k + view.y,
        }
      : null

  const showLabel = (n: SimNode) =>
    mode === 'docs' ||
    hoverId === n.id ||
    selectedId === n.id ||
    n.distance === 0 ||
    nodeRadius(n.mention_count, maxMc) >= 8

  if (size.w === 0) {
    return (
      <div ref={containerRef} className="h-full w-full">
        <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground/60">
          计算布局…
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
        <rect width={size.w} height={size.h} fill="transparent" />
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {/* 边 */}
          {simEdgesRef.current.map((e, i) => {
            const s = typeof e.source === 'string' ? null : e.source
            const t = typeof e.target === 'string' ? null : e.target
            if (!s || !t) return null
            const incident = focusEdges ? focusEdges.has(e) : true
            const dim = focusEdges !== null && !incident
            const w = e.weight / maxWeight
            return (
              <line
                key={i}
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
                style={{ stroke: 'rgb(var(--graph-edge))' }}
                strokeWidth={0.6 + 1.5 * w}
                strokeOpacity={dim ? 0.04 : incident ? 0.85 : 0.2 + 0.4 * w}
              />
            )
          })}
          {/* 节点 */}
          {simNodesRef.current.map((n) => {
            const dim = hoverNeighbors !== null && !hoverNeighbors.has(n.id)
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
              ? `${hoverNode.mention_count} 个块`
              : `${entityKindLabel(hoverNode.kind)} · ${hoverNode.mention_count} 次提及`}
          </div>
        </div>
      )}

      {/* 图例 */}
      <div className="absolute bottom-2.5 left-2.5 z-10 pointer-events-none rounded-lg border border-border bg-card/90 backdrop-blur px-2.5 py-1.5 text-[10.5px] text-muted-foreground leading-relaxed">
        {isDoc ? (
          <>
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-2.5 rounded-sm" style={{ background: GRAPH_NOTE_COLOR }} />
              <span>笔记</span>
            </div>
            <div className="mt-1">大小 = 内容量 · 连线 = 关联（共享实体 / 引用）</div>
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
            <div className="mt-1">大小 = 提及次数 · 连线 = 共现</div>
          </>
        )}
      </div>
    </div>
  )
}

/** 实体节点：圆形 + kind 着色 + 选中光晕/虚线环 + 锚点光晕 */
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
  return (
    <>
      {/* 隐形放大命中区（点击更易命中） */}
      <circle r={r + 8} fill="transparent" />
      {(isSelected || isAnchor || isHover) && (
        <circle
          r={r + (isSelected ? 7 : 4)}
          fill="rgb(var(--primary))"
          opacity={isSelected ? 0.22 : isHover ? 0.18 : 0.12}
        />
      )}
      {isSelected && (
        <circle r={r + 4} fill="none" style={{ stroke: 'rgb(var(--primary))' }} strokeWidth={1.5} strokeDasharray="3 3" />
      )}
      <circle
        r={r}
        style={{
          fill: graphKindColor(n.kind),
          stroke: isHover ? 'rgb(var(--foreground))' : 'none',
        }}
        strokeWidth={isHover ? 1.5 : 0}
      />
      {showLabel && (
        <text y={r + 13} textAnchor="middle" className="graph-node-label" style={{ fill: 'rgb(var(--foreground))' }}>
          {n.display.length > LABEL_MAX ? n.display.slice(0, LABEL_MAX) + '…' : n.display}
        </text>
      )}
    </>
  )
}

/** 笔记节点：圆角矩形 + 墨色填充 + 右侧标题 + 选中/锚点光晕 */
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
  const h = Math.max(24, w * 0.6)
  return (
    <>
      {/* 隐形放大命中区 */}
      <rect x={-w / 2 - 8} y={-h / 2 - 8} width={w + 16} height={h + 16} fill="transparent" />
      {(isSelected || isAnchor || isHover) && (
        <rect
          x={-w / 2 - (isSelected ? 7 : 4)}
          y={-h / 2 - (isSelected ? 7 : 4)}
          width={w + (isSelected ? 14 : 8)}
          height={h + (isSelected ? 14 : 8)}
          rx={isSelected ? 12 : 10}
          fill="rgb(var(--primary))"
          opacity={isSelected ? 0.22 : isHover ? 0.18 : 0.12}
        />
      )}
      {isSelected && (
        <rect
          x={-w / 2 - 4}
          y={-h / 2 - 4}
          width={w + 8}
          height={h + 8}
          rx={9}
          fill="none"
          style={{ stroke: 'rgb(var(--primary))' }}
          strokeWidth={1.5}
          strokeDasharray="3 3"
        />
      )}
      <rect
        x={-w / 2}
        y={-h / 2}
        width={w}
        height={h}
        rx={7}
        style={{
          fill: GRAPH_NOTE_COLOR,
          stroke: isHover ? 'rgb(var(--foreground))' : 'none',
        }}
        strokeWidth={isHover ? 1.5 : 0}
      />
      {showLabel && (
        <text
          x={w / 2 + 7}
          y={4}
          textAnchor="start"
          className="graph-node-label"
          style={{ fill: 'rgb(var(--foreground))' }}
        >
          {n.display.length > LABEL_MAX ? n.display.slice(0, LABEL_MAX) + '…' : n.display}
        </text>
      )}
    </>
  )
}
