/**
 * 编辑器图片外挂通道：预览 widget 点击 → 弹层（替换/资源库/查看原图）→ 写回 markdown。
 * 仿 editTable.ts 的 CustomEvent，避免 widget（非 React）直接碰 React 弹层状态。
 */

export const EDIT_IMAGE_EVENT = 'notefast:edit-image'

export interface EditImageDetail {
  /** 图片行 markdown 区间 [from, to)，替换时整行重写 */
  from: number
  to: number
  /** markdown 里的原始 src（asset:<sha256> 或外部 URL），替换时保留 alt 只换 src */
  rawSrc: string
  alt: string
  /** 图片在视口内的位置，用于弹层定位 */
  rect: { top: number; left: number; width: number; height: number }
}

export function dispatchEditImage(detail: EditImageDetail): void {
  window.dispatchEvent(new CustomEvent<EditImageDetail>(EDIT_IMAGE_EVENT, { detail }))
}