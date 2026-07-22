/**
 * 文档生命周期状态（收集箱 vs 正式笔记）
 *
 * 存在 document 根 `properties.status`：
 * - 缺省 / `note` → 正式笔记（出现在「所有文档」）
 * - `inbox` → 收集箱（主列表默认排除，待整理）
 */

import { parsePropertiesObject } from './tags'

export type DocStatus = 'note' | 'inbox'

/** 从 properties 读状态；非法或缺失一律视为 note */
export function readDocStatusFromProperties(properties: unknown): DocStatus {
  const obj = parsePropertiesObject(properties)
  return obj.status === 'inbox' ? 'inbox' : 'note'
}

export function isInboxDoc(properties: unknown): boolean {
  return readDocStatusFromProperties(properties) === 'inbox'
}

/**
 * 写入 status。note 时删除字段（与默认一致，避免脏 properties）。
 */
export function setDocStatusInProperties(properties: unknown, status: DocStatus): string {
  const props = parsePropertiesObject(properties)
  if (status === 'inbox') {
    props.status = 'inbox'
  } else {
    delete props.status
  }
  return JSON.stringify(props)
}

/** 解析 list/MCP 的 status 查询：inbox | note | all；默认 note（排除收集箱） */
export function parseDocStatusFilter(raw: string | null | undefined): 'note' | 'inbox' | 'all' {
  const v = (raw || '').trim().toLowerCase()
  if (v === 'inbox') return 'inbox'
  if (v === 'all') return 'all'
  return 'note'
}
