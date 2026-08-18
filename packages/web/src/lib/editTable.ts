/**
 * 编辑器表格外挂通道：预览 widget 点击 → 对话框编辑 → 写回 GFM。
 * 仿 askAi.ts 的 CustomEvent，避免 widget（非 React）直接碰对话框状态。
 */

export const EDIT_TABLE_EVENT = 'notefast:edit-table'

export interface EditTableDetail {
  from: number
  to: number
  lines: string[]
}

export function dispatchEditTable(detail: EditTableDetail): void {
  window.dispatchEvent(new CustomEvent<EditTableDetail>(EDIT_TABLE_EVENT, { detail }))
}
