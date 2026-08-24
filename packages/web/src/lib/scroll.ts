/**
 * 手动 rAF 平滑滚动。
 *
 * 为什么不用原生 scrollIntoView({behavior:'smooth'})：
 * 在部分环境（headless 浏览器、rAF 被节流的页面）原生平滑滚动会静默失效，
 * 表现为「点击没反应」。手动 rAF 实现在任何环境都可靠。
 * 系统减弱动态效果时瞬时落地。
 */

import { prefersReducedMotion } from './reducedMotion'

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
  if (duration <= 0 || prefersReducedMotion()) {
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

/** 大纲定位落点与滚动容器上沿的间距（px）。
 *  浏览器下容器上沿即顶栏下沿（≈57px），落点 ≈ 73px 视口；与原固定 72px 观感一致。 */
export const SCROLL_TOP_GAP = 16

/** 定位落点的视口 y：滚动容器上沿 + gap。
 *  以容器为基准而非固定视口偏移——Tauri 壳在顶栏之上还有 36px 标题栏（容器上沿 ≈92px），
 *  若按固定 72px 视口偏移，目标 heading 会被压进顶栏区域（容器上沿以下才可见），
 *  表现为「定位到的标题被上方遮挡一截」；useActiveHeading 的激活线同理必须跟随容器。 */
export function scrollLandingTop(el: HTMLElement, gap = SCROLL_TOP_GAP): number {
  const scroller = findScrollableAncestor(el)
  return (scroller ? scroller.getBoundingClientRect().top : 0) + gap
}

/** 平滑滚动到指定元素（停在滚动容器上沿 + gap 处，见 scrollLandingTop） */
export function scrollToElement(el: HTMLElement, gap = SCROLL_TOP_GAP, duration = 260) {
  const scroller = findScrollableAncestor(el)
  if (!scroller) {
    el.scrollIntoView({ block: 'start' })
    return
  }
  // 滚动 delta = el 当前视口 top - 落点视口 top（视口内滚动位移 1:1）
  const target = el.getBoundingClientRect().top - scrollLandingTop(el, gap) + scroller.scrollTop
  smoothScrollTo(scroller, Math.max(0, target), duration)
}
