/**
 * 滚动联动：当前活跃 heading id（「最后一个已滚过顶部激活线的」heading）
 *
 * 语义（标准大纲跟随）：找到 document order 中最后一个
 * `getBoundingClientRect().top <= 激活线` 的 heading —— 即用户已滚过它、
 * 正在读它下方内容的章节；一个都没滚过（文档开头）时高亮第一个。
 * 结尾滚动到底时停在最后一个 heading，始终有值。
 *
 * 为什么不用 IntersectionObserver（旧实现，2026-08-11 替换）：
 *  - 旧实现 rootMargin '-72px 0px -85% 0px' 把激活带压成视口顶部一条
 *    约 15%−72px 的窄带，语义是「物理上正处在这条带内的 heading 才高亮」：
 *      * 滚动稍快，heading 从带上方直接跳到带下方，IO 异步快照捕捉不到
 *        intersecting → 从未高亮（快速阅读时几乎不可用）
 *      * 两节之间没有任何 heading 在带内 → activeId = null（最常见场景）
 *      * 文档开头 / 滚到底部同样 null
 *  - 改用 scroll listener + getBoundingClientRect：
 *      * 精确计算位置，与 scrollToElement 的 topOffset=72 一致（点击大纲后
 *        heading 停在 72px 处，激活线同值，所见即所得）
 *      * 滚动容器用 findScrollableAncestor 精确定位（嵌套 .overflow-y-auto），
 *        不依赖 IO 的隐式 ancestor 语义
 *      * rAF throttle 合并高频 scroll，开销可忽略
 */

import { useEffect, useState } from 'react'
import { findScrollableAncestor } from '../lib/scroll'

/** 激活线：与 doc.tsx scrollToElement 的 topOffset 一致（72px 顶栏） */
const ACTIVATION_LINE = 72
/** 激活容差：scrollTop 可能落在 subpixel（如 72.4px），严格 <= 72 会漏判——4px 内都算「已滚过」 */
const ACTIVATION_TOLERANCE = 4

/**
 * 从 heading 的视口 top 序列（document order）选出活跃项下标。
 * 规则：最后一个 top <= 激活线 + 容差 的下标；一个都没滚过 → 0（文档开头高亮第一节）。
 * 容差吸收滚动定位的 subpixel 误差（scrollToElement 停在 72px 时 rect.top 可能是 72.4）。
 * 返回下标，供调用方映射回 heading id；空数组返回 -1。
 */
export function pickActiveHeadingIndex(
  tops: readonly number[],
  activationLine = ACTIVATION_LINE,
  tolerance = ACTIVATION_TOLERANCE,
): number {
  if (tops.length === 0) return -1
  const line = activationLine + tolerance
  let current = -1
  for (let i = 0; i < tops.length; i++) {
    if (tops[i]! <= line) current = i
    else break // document order：后续只会更靠下
  }
  return current === -1 ? 0 : current
}

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

    let raf = 0
    const compute = () => {
      raf = 0
      // 收集 heading 的视口 top（document order），交给纯函数选活跃项
      const tops = elements.map((el) => el.getBoundingClientRect().top)
      setActiveId(elements[pickActiveHeadingIndex(tops)]?.id ?? null)
    }

    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(compute)
    }

    compute()
    // 滚动容器：heading 最近的可滚动祖先（正文区 .overflow-y-auto）；
    // 内容不足一屏时无滚动容器，退回 window（resize 仍触发重算）
    const scroller = findScrollableAncestor(elements[0]!) ?? window
    scroller.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
    // headingIds 是 React state，每次 render 都会是新 array——频繁重建 observer/listener
    // 没意义。用 length + 首尾 id 当 memo key（内容顺序变化会体现在首尾上）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headingIds.length, headingIds[0], headingIds[headingIds.length - 1]])

  return activeId
}
