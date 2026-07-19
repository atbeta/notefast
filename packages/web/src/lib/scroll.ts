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

/** 平滑滚动容器到目标 scrollTop */
export function smoothScrollTo(container: HTMLElement, target: number, duration = 260) {
  const start = container.scrollTop
  const diff = target - start
  if (Math.abs(diff) < 2) return
  const startTime = performance.now()
  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

  const step = (now: number) => {
    const t = Math.min(1, (now - startTime) / duration)
    container.scrollTop = start + diff * easeOutCubic(t)
    if (t < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

/** 滚动到指定元素（相对其滚动容器定位，顶部预留偏移） */
export function scrollToElement(el: HTMLElement, topOffset = 72) {
  const scroller = findScrollableAncestor(el)
  if (!scroller) {
    el.scrollIntoView({ block: 'start' })
    return
  }
  const target =
    el.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top +
    scroller.scrollTop -
    topOffset
  smoothScrollTo(scroller, Math.max(0, target))
}
