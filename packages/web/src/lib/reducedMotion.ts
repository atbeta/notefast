/** 系统「减弱动态效果」。CSS 层已一刀切，JS 动画入口也要读这里。 */
export function prefersReducedMotion(): boolean {
  if (typeof matchMedia !== 'function') return false
  return matchMedia('(prefers-reduced-motion: reduce)').matches
}
