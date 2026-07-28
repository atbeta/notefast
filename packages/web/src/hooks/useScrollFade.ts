import { useEffect, useRef } from 'react'

/**
 * 滚动边缘羽化：返回 ref 挂到滚动容器上，按当前滚动位置维护
 * data-fade-top / data-fade-bottom（仅当该方向还有溢出内容时为 true），
 * CSS（index.css 的 .scroll-fade）据此只对那一侧加 mask 淡出。
 *
 * 直接写 dataset 而非 setState —— 滚动是高频事件，避免重渲染；
 * 静态 mask 会在已滚到顶/底时错误地淡化首尾内容，所以必须边缘感知。
 */
export function useScrollFade<T extends HTMLElement>() {
  const ref = useRef<T>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      el.dataset.fadeTop = String(el.scrollTop > 1)
      el.dataset.fadeBottom = String(el.scrollTop + el.clientHeight < el.scrollHeight - 1)
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    // 容器尺寸变化（窗口缩放 / 面板开合）与直接子节点增删（异步列表加载）后重算
    const ro = new ResizeObserver(update)
    ro.observe(el)
    const mo = new MutationObserver(update)
    mo.observe(el, { childList: true })
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
      mo.disconnect()
    }
  }, [])

  return ref
}
