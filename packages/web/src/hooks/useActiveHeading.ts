/**
 * 滚动联动：当前活跃 heading id（最顶上的"已过" heading）
 *
 * 用 IntersectionObserver 而不是 scroll listener：
 *  - 文档页的滚动容器是嵌套 .overflow-y-auto（不是 window），
 *    监听 window scroll 漏；IO 自带"任意 ancestor 滚动"语义
 *  - 自带 throttle / rAF batching
 *  - 浏览器内部已做"反向延迟合并"——比 onscroll 高频事件可靠
 *
 * rootMargin '-72px 0px -85% 0px' 把激活带压成顶部 15%（扣掉 72px 顶栏），
 * 只有"已经滚过、还没滚出去"的 heading 算 intersecting。多个同时 intersecting
 * 时取 document order 最前的那个——即"最新滚过的"那一节。
 */

import { useEffect, useState } from 'react'

export function useActiveHeading(headingIds: string[]): string | null {
  const [activeId, setActiveId] = useState<string | null>(null)

  useEffect(() => {
    if (headingIds.length === 0 || typeof window === 'undefined') return

    const elements = headingIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null)
    if (elements.length === 0) {
      setActiveId(null)
      return
    }

    const intersecting = new Set<string>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) intersecting.add(entry.target.id)
          else intersecting.delete(entry.target.id)
        }
        // headingIds 已是 document order，第一个 intersecting 即最新滚过的
        const topmost = headingIds.find((id) => intersecting.has(id)) ?? null
        setActiveId(topmost)
      },
      {
        rootMargin: '-72px 0px -85% 0px',
        threshold: 0,
      },
    )

    elements.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
    // headingIds 是 React state，每次 reference 变就重建 observer。
    // flatHeadings 在 doc.tsx 每次 render 都会是新 array——会导致频繁 disconnect/reconnect。
    // 用 length + 首尾 id 当 memo key：
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headingIds.length, headingIds[0], headingIds[headingIds.length - 1]])

  return activeId
}