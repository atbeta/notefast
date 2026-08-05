import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useLocation, matchPath } from 'react-router-dom'

/** 应用路由表（与 App.tsx 一致）：用于判断「同路由仅参数变化」的导航 */
const ROUTE_PATTERNS = ['/', '/new', '/doc/:id', '/inbox', '/archived', '/entities', '/graph', '/settings/*']

/**
 * 路由切换过渡：旧路径分支不立刻卸载，靠 useLayoutEffect 在浏览器绘制前
 * 把上一帧的 children 截到 outgoing 里，叠在新页之上做 200ms 的淡出。
 * - 一次性同时挂两个分支，避免「旧 → 空白 → 新」的闪烁
 * - old 分支 pointer-events-none，滚动/点击全部落到新分支
 * - 自身不负责新页淡入（各路由根节点的 animate-fade-in 已经做了 280ms 入场）
 * - 注意：outgoing 是在新位置重新挂载的并行实例（读当前 location），
 *   并非旧页的状态快照——所以「同路由仅参数变化」（如 /doc/A → /doc/B）
 *   必须跳过：文档页自身会保留旧内容直到新数据到达后瞬时替换，再叠一个
 *   并行新实例只会在标题/字数/标签区产生半透明重影（还会重复 fetch）。
 */
export default function RouteTransition({ children }: { children: ReactNode }) {
  const location = useLocation()
  const [outgoing, setOutgoing] = useState<{ node: ReactNode; ts: number } | null>(null)
  const prevKeyRef = useRef(location.key)
  const prevPathRef = useRef(location.pathname)
  const prevChildrenRef = useRef<ReactNode>(children)

  useLayoutEffect(() => {
    if (prevKeyRef.current !== location.key) {
      const oldNode = prevChildrenRef.current
      const ts = Date.now()
      // 同路由导航（hash 变化，或 /doc/:id 仅参数变化）不播放离场动画——
      // 目标页自身处理了过渡（hash 跳转是同一篇文档；文档切换保留旧内容），
      // 叠影既是视觉闪烁，又会制造重复 block id 幽灵节点
      const sameRoute = ROUTE_PATTERNS.some(
        (p) => matchPath(p, prevPathRef.current) && matchPath(p, location.pathname),
      )
      prevKeyRef.current = location.key
      prevPathRef.current = location.pathname
      if (!sameRoute) {
        setOutgoing({ node: oldNode, ts })
        window.setTimeout(() => {
          setOutgoing((curr) => (curr && curr.ts === ts ? null : curr))
        }, 200)
      }
    }
    prevChildrenRef.current = children
  }, [location.key, location.pathname, children])

  return (
    <div className="relative h-full">
      {outgoing && (
        <div
          key={outgoing.ts}
          className="absolute inset-0 z-[2] overflow-hidden pointer-events-none animate-page-leave"
        >
          {outgoing.node}
        </div>
      )}
      <div className="relative h-full">{children}</div>
    </div>
  )
}
