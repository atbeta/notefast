/**
 * 图谱缩放：世界坐标（位置、相对大小）跟 k 走；
 * 字号 / 线宽 / 光晕 / 命中区钉在屏幕像素上（画在 scale(k) 组内时用 screenToWorld）。
 */

export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 3

export const MIN_EDGE_SCREEN_PX = 0.9
export const MIN_NODE_SCREEN_PX = 4
export const MAX_NODE_SCREEN_PX = 22
export const MIN_DOC_SCREEN_W = 32
export const MAX_DOC_SCREEN_W = 100
export const LABEL_FONT_PX = 10
export const LABEL_GAP_PX = 12
export const LABEL_STROKE_PX = 3
/** 节点在屏幕上至少这么大才出常驻标签（悬停/选中始终出） */
export const LABEL_MIN_SCREEN_PX = 8
export const NODE_STROKE_PX = 1.4
export const SELECT_RING_PX = 1.5
export const SELECT_RING_PAD_PX = 3.5
export const HALO_PAD_PX = 3
export const HIT_PAD_PX = 8
export const SHADOW_BLUR_PX = 2
export const SHADOW_DY_PX = 1.2

/** scale(k) 组内：屏幕像素 → 世界单位 */
export function screenToWorld(px: number, k: number): number {
  return px / Math.max(k, 1e-6)
}

/** 世界尺寸经 k 投影到屏幕后夹在 [minPx, maxPx]，再折回世界单位供绘制 */
export function clampWorldToScreen(world: number, k: number, minPx: number, maxPx: number): number {
  const kk = Math.max(k, 1e-6)
  const screen = world * kk
  return Math.min(maxPx, Math.max(minPx, screen)) / kk
}

export function nodeRadius(mc: number, maxMc: number): number {
  return 5 + 13 * Math.min(1, Math.sqrt(mc) / Math.sqrt(Math.max(maxMc, 1)))
}

export function docWidth(mc: number, maxMc: number): number {
  return 46 + 54 * Math.min(1, Math.sqrt(mc) / Math.sqrt(Math.max(maxMc, 1)))
}

export function nodeDrawRadius(mc: number, maxMc: number, k: number): number {
  return clampWorldToScreen(nodeRadius(mc, maxMc), k, MIN_NODE_SCREEN_PX, MAX_NODE_SCREEN_PX)
}

export function docDrawWidth(mc: number, maxMc: number, k: number): number {
  return clampWorldToScreen(docWidth(mc, maxMc), k, MIN_DOC_SCREEN_W, MAX_DOC_SCREEN_W)
}

/** 边宽钉死在屏幕像素（配合 vector-effect: non-scaling-stroke） */
export function edgeScreenWidth(weight01: number, highlighted: boolean): number {
  const base = highlighted ? 1 + 1.5 * weight01 : 0.6 + 1.2 * weight01
  return Math.max(MIN_EDGE_SCREEN_PX, base)
}
