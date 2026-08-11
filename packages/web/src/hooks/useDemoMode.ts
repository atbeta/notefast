/**
 * 演示模式：整体放大文档（zoom 等比缩放标题/正文/代码/表格/图片）
 *
 * 与旧四档字号（useDocFontSize，已废弃）不同：旧的只改 .reading-prose 根字号，
 * 标题/代码/表格是写死 px 不跟随 → 非等比很难看。演示模式用 CSS zoom
 * 等比缩放整个阅读列，所有元素同步放大。
 *
 * 设计决策（2026-08-11）：
 * - 平时固定 100%，不显示任何缩放 UI；进入演示模式后才可放大
 * - 倍数多档可调（125/150/175/200%），不锁死单档
 * - **不持久化**：演示是临时场景，需要时自己开，刷新/退出即恢复
 * - 演示模式下隐藏左侧全局导航；右侧大纲 rail 默认折叠但可手动展开
 * - 编辑态不缩放（演示是给别人看，自己写不需要）；lightbox 是 portal 不受影响
 */

import { useSyncExternalStore, type ReactElement } from 'react'

export type DemoZoom = 1.25 | 1.5 | 1.75 | 2

/** 演示模式放大档位（可调整的上限档） */
export const DEMO_ZOOMS: readonly DemoZoom[] = [1.25, 1.5, 1.75, 2] as const

/** 默认进入演示模式时的起始放大档（1.5x，效果明显） */
const DEFAULT_ZOOM_INDEX = 1

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

/** 当前生效的缩放倍数（未激活 = 1，不放大） */
export function useDemoZoom(): number {
  const { active, zoomIndex } = useDemoMode()
  return active ? DEMO_ZOOMS[zoomIndex]! : 1
}

/** 进入演示模式（保持当前档位；未进入过则用默认档） */
export function enterDemoMode(): void {
  if (!state.active) setState({ active: true, zoomIndex: state.zoomIndex })
}

/** 退出演示模式（不重置档位，下次进入沿用） */
export function exitDemoMode(): void {
  if (state.active) setState({ active: false, zoomIndex: state.zoomIndex })
}

/** 切换演示模式开关 */
export function toggleDemoMode(): void {
  setState(state.active ? { active: false, zoomIndex: state.zoomIndex } : { active: true, zoomIndex: state.zoomIndex })
}

/** 循环放大/缩小（Ctrl+= / Ctrl+-）；未激活时自动进入 */
export function cycleDemoZoom(dir: 1 | -1): number {
  const nextIndex = (state.zoomIndex + dir + DEMO_ZOOMS.length) % DEMO_ZOOMS.length
  setState({ active: true, zoomIndex: nextIndex })
  return DEMO_ZOOMS[nextIndex]!
}

/** 复位到 100%（Ctrl+0）；同时退出演示模式 */
export function resetDemoZoom(): void {
  setState({ active: false, zoomIndex: DEFAULT_ZOOM_INDEX })
}

/** 直接设置档位（按钮组点击） */
export function setDemoZoomIndex(index: number): void {
  const clamped = Math.min(Math.max(index, 0), DEMO_ZOOMS.length - 1)
  setState({ active: true, zoomIndex: clamped })
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
