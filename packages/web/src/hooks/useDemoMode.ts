/**
 * 阅读缩放 + 演示模式（共享同一缩放状态，active 只控制 UI 隐藏）
 *
 * 与旧四档字号（useDocFontSize，已废弃）不同：旧的只改 .reading-prose 根字号，
 * 标题/代码/表格是写死 px 不跟随 → 非等比很难看。现在用 CSS zoom 等比缩放
 * 整个阅读列，所有元素同步放大。
 *
 * 设计决策（2026-08-11 / 2026-08-12 更新）：
 * - **缩放与演示解耦**：zoom 是独立能力，阅读模式即可调（顶栏档位组常显），
 *   立即生效；active 只决定「是否隐藏 UI（侧栏/窗口标题栏/rail 默认折叠）」
 * - 档位 100/125/150/175/200%（100% = 阅读默认，演示自动跳到 150%）
 * - **不持久化**：临时场景，需要时自己开，刷新/退出即恢复
 * - 演示模式下隐藏左侧全局导航 + 原生壳标题栏；右侧大纲 rail 默认折叠可展开
 * - 编辑态不缩放（自己写不需要）；lightbox 是 portal 不受影响
 */

import { useSyncExternalStore, type ReactElement } from 'react'

export type DemoZoom = 1 | 1.25 | 1.5 | 1.75 | 2

/** 缩放档位（100% = 阅读默认；上限 200%，投影够用） */
export const DEMO_ZOOMS: readonly DemoZoom[] = [1, 1.25, 1.5, 1.75, 2] as const

/** 阅读默认档（100%） */
const DEFAULT_ZOOM_INDEX = 0
/** 进入演示模式时的起始放大档（150%，效果明显） */
const DEMO_ENTER_INDEX = 2

interface DemoState {
  active: boolean
  zoomIndex: number
}

let state: DemoState = { active: false, zoomIndex: DEFAULT_ZOOM_INDEX }
const listeners = new Set<() => void>()

function emit(): void {
  listeners.forEach((l) => l())
}

function setState(next: DemoState): void {
  state = next
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): DemoState {
  return state
}

function getServerSnapshot(): DemoState {
  return { active: false, zoomIndex: DEFAULT_ZOOM_INDEX }
}

/** 非 hook 读取（测试 / 纯逻辑用） */
export function getDemoState(): DemoState {
  return state
}

/** 订阅演示模式状态 */
export function useDemoMode(): DemoState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** 当前生效的缩放倍数（阅读/演示一致；100% 时 = 1 不放大） */
export function useDemoZoom(): number {
  const { zoomIndex } = useDemoMode()
  return DEMO_ZOOMS[zoomIndex]!
}

/** 进入演示模式：隐藏 UI 骨架；未手动调过缩放时跳到默认演示档（150%） */
export function enterDemoMode(): void {
  if (state.active) return
  const zoomIndex = state.zoomIndex === DEFAULT_ZOOM_INDEX ? DEMO_ENTER_INDEX : state.zoomIndex
  setState({ active: true, zoomIndex })
}

/** 退出演示模式（不重置档位，下次进入沿用） */
export function exitDemoMode(): void {
  if (state.active) setState({ active: false, zoomIndex: state.zoomIndex })
}

/** 切换演示模式开关 */
export function toggleDemoMode(): void {
  if (state.active) exitDemoMode()
  else enterDemoMode()
}

/** 循环放大/缩小（Ctrl+= / Ctrl+-）；不改变演示开关，阅读模式即可用 */
export function cycleDemoZoom(dir: 1 | -1): number {
  const nextIndex = (state.zoomIndex + dir + DEMO_ZOOMS.length) % DEMO_ZOOMS.length
  setState({ active: state.active, zoomIndex: nextIndex })
  return DEMO_ZOOMS[nextIndex]!
}

/** 复位到 100%（Ctrl+0）；同时退出演示模式 */
export function resetDemoZoom(): void {
  setState({ active: false, zoomIndex: DEFAULT_ZOOM_INDEX })
}

/** 直接设置档位（按钮组点击）；不改变演示开关 */
export function setDemoZoomIndex(index: number): void {
  const clamped = Math.min(Math.max(index, 0), DEMO_ZOOMS.length - 1)
  setState({ active: state.active, zoomIndex: clamped })
}

/**
 * 把当前 zoom 写到 :root 的 CSS 变量。App 树里挂载一次即可。
 * 渲染 null — 纯副作用组件。
 */
export function DemoModeApplier(): ReactElement | null {
  const zoom = useDemoZoom()
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--notefast-doc-zoom', String(zoom))
  }
  return null
}
