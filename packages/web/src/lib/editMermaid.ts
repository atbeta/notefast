/**
 * 编辑器 Mermaid 预览外挂通道：widget 展开按钮 → 灯箱查看原图。
 * 仿 editImage.ts 的 CustomEvent，避免 widget（非 React）直接碰 React 灯箱状态。
 */

export const VIEW_MERMAID_EVENT = 'notefast:view-mermaid'

export interface ViewMermaidDetail {
  /** 已渲染的 SVG 字符串（灯箱直接注入） */
  svg: string
  label: string
}

export function dispatchViewMermaid(detail: ViewMermaidDetail): void {
  window.dispatchEvent(new CustomEvent<ViewMermaidDetail>(VIEW_MERMAID_EVENT, { detail }))
}