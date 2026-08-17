/**
 * 手动 rAF 平滑滚动。
 *
 * 为什么不用原生 scrollIntoView({behavior:'smooth'})：
 * 在部分环境（headless 浏览器、rAF 被节流的页面）原生平滑滚动会静默失效，
 * 表现为「点击没反应」。手动 rAF 实现在任何环境都可靠。
 */

/** 找到元素最近的可纵向滚动祖先 */
export function findScrollableAncestor(el: HTMLElement): HTMLElement | null {
  let cur = el.parentElement
  while (cur) {
    const s = getComputedStyle(cur)
    if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && cur.scrollHeight > cur.clientHeight) {
      return cur
    }
    cur = cur.parentElement
  }
  return null
}

/** 平滑滚动容器到目标 scrollTop；duration<=0 时瞬时定位（深链接落地等不允许动画竞争的场景） */
export function smoothScrollTo(container: HTMLElement, target: number, duration = 260) {
  const start = container.scrollTop
  const diff = target - start
  if (Math.abs(diff) < 2) return
  if (duration <= 0) {
    container.scrollTop = target
    return
  }
  const startTime = performance.now()
  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

  const step = (now: number) => {
    const t = Math.min(1, (now - startTime) / duration)
    container.scrollTop = start + diff * easeOutCubic(t)
    if (t < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

/** 平滑滚动到指定元素（相对视口顶部预留偏移） */
export function scrollToElement(el: HTMLElement, topOffset = 72, duration = 260) {
  const scroller = findScrollableAncestor(el)
  if (!scroller) {
    el.scrollIntoView({ block: 'start' })
    return
  }
  // 目标 = 让 el 停在「视口 topOffset 处」：滚动 delta = el 当前视口 top - topOffset。
  // 注意是视口基准而非 scroller 基准——doc 页滚动容器顶部下方常有 PageHeader（h-14=56px），
  // 若按 scroller 内偏移算，heading 会停在视口 56+72=128px，既偏下又让 useActiveHeading
  // 的激活线（视口 72px）判定「未滚过」→ 高亮跳回上方章节。
  const target = el.getBoundingClientRect().top - topOffset + scroller.scrollTop
  smoothScrollTo(scroller, Math.max(0, target), duration)
}
