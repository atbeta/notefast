import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'

/**
 * 路由切换过渡：旧页不立刻卸载，靠 useLayoutEffect 在浏览器绘制前
 * 把上一帧的 children 截到 outgoing 里，叠在新页之上做 160ms 的淡出。
 * - 一次性同时挂两个分支，避免「旧 → 空白 → 新」的闪烁
 * - old 分支 pointer-events-none，滚动/点击全部落到新分支
 * - 自身不负责新页淡入（各路由根节点的 animate-fade-in 已经做了 280ms 入场）
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
      // 同路径导航（仅 hash 变化，如引用/锚点跳转）不播放离场动画——
      // 旧页与新页是同一篇文档，叠影既是视觉闪烁，又会制造重复 block id 幽灵节点
      const samePath = prevPathRef.current === location.pathname
      prevKeyRef.current = location.key
      prevPathRef.current = location.pathname
      if (!samePath) {
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
